
'use strict';

const {randomBytes,createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const quotes=require('./postgres-quotes'),source=require('./quote-buyer-source');
const policy=require('../commercial/agent-plan'),pricing=require('../pricing/postgres-promotions');
const paymentTerms=require('./postgres-payment-terms'),credentials=require('../connections/credentials');
const storage=require('../commercial/storage-capacity'),audit=require('../operations/postgres-security-audit');
const KIND='agent.sales-quote.acceptance.v1';
const links='stockchief_runtime.quote_buyer_links',receipts='stockchief_runtime.quote_buyer_acceptances';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});
const tokenHash=token=>createHash('sha256').update(token).digest('hex');
const expectedError=error=>[400,402,403,404,409,422].includes(error.status);
const acceptanceHash=(link,name,email)=>pricing.hash({link:link.id,revision:link.revision,offer:link.offer_hash,name,email});

async function linked(db,workspaceId,quoteId,{lock=false}={}){
  return (await db.query('SELECT * FROM '+links+' WHERE workspace_id=$1 AND quote_id=$2'+(lock?' FOR UPDATE':''),
    [workspaceId,quoteId])).rows[0];
}
async function accepted(db,workspaceId,quoteId,{lock=false}={}){
  return (await db.query('SELECT * FROM '+receipts+' WHERE workspace_id=$1 AND quote_id=$2'+(lock?' FOR UPDATE':''),
    [workspaceId,quoteId])).rows[0];
}
async function exact(db,ctx,q,link,{lockPricing=false}={}){
  if(!link?.enabled||pricing.hash(link.offer)!==link.offer_hash)throw new ValidationError('The private quotation is unavailable.');
  const current=await source.currentQuote(db,ctx,q,{lockPricing});
  if(pricing.hash(current.source)!==pricing.hash(link.offer.source)){
    throw new ValidationError('The quoted products, customer contact or delivery details changed. Review a fresh quotation.');
  }
  return current;
}

async function publish(database,ctx,id,input){
  return tx(database,async db=>{
    await source.access(db,ctx,{lock:true});
    const q=await quotes.get(db,ctx.workspaceId,id,{lock:true});
    const prior=await linked(db,ctx.workspaceId,id,{lock:true});
    if(input.confirmed!=='yes'||input.expectedQuote!==q.pricing_hash||Number(input.linkRevision||0)!==(prior?.revision||0)){
      throw new ValidationError('Review and confirm the current quotation before publishing its private link.');
    }
    if(await accepted(db,ctx.workspaceId,id))throw new ValidationError('This buyer acceptance already has a receipt. Review the receipt or prepare a fresh quotation.');
    const routine=input.routine==='yes';
    const maximum=routine?require('../domain/currency').userToMinor(input.maximum,q.pricing.currency):null;
    if(routine){
      await source.access(db,ctx,{automatic:true});
      if(!Number.isSafeInteger(maximum)||maximum<=0||maximum<q.pricing.totalMinor){
        throw new ValidationError('Set the exact authorized total or a higher limit in the quoted currency.');
      }
    }
    const current=await source.currentQuote(db,ctx,q,{lockPricing:true});
    const terms=paymentTerms.forQuote(await paymentTerms.forCustomer(db,ctx.workspaceId,q.customer_id));
    const offer={source:current.source,paymentTerms:terms},fingerprint=pricing.hash(offer);
    if(input.expectedOffer!==fingerprint)throw new ValidationError('The customer, payment terms or delivery changed. Reload and review before sharing.');
    const token=randomBytes(32).toString('base64url'),encrypted=credentials.encrypt(token);
    const ciphertext={ciphertext:encrypted.ciphertext,iv:encrypted.iv,auth_tag:encrypted.authTag};
    const linkId=prior?.id||newId('quote-link');
    await storage.reserve(db,ctx.workspaceId,'quote-buyer-link:'+linkId+':'+(Number(prior?.revision||0)+1),
      Buffer.byteLength(JSON.stringify(offer))*2+4096,{finished:true});
    await db.query(`INSERT INTO ${links}(id,workspace_id,quote_id,customer_id,published_by,token_hash,token_cipher,offer_hash,offer,routine,maximum_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11)
      ON CONFLICT(quote_id) DO UPDATE SET published_by=EXCLUDED.published_by,token_hash=EXCLUDED.token_hash,token_cipher=EXCLUDED.token_cipher,
      offer_hash=EXCLUDED.offer_hash,offer=EXCLUDED.offer,routine=EXCLUDED.routine,maximum_minor=EXCLUDED.maximum_minor,enabled=true,
      revision=quote_buyer_links.revision+1,published_at=now()`,
    [linkId,ctx.workspaceId,q.id,q.customer_id,ctx.actorId,tokenHash(token),JSON.stringify(ciphertext),fingerprint,JSON.stringify(offer),routine,maximum]);
    await audit.record(db,ctx,{action:'Published a private quotation link',reference:q.id,
      after:{linkId,offerHash:fingerprint,customerId:q.customer_id,routine,maximum}});
    return {id:linkId};
  });
}

async function revokeInTransaction(db,ctx,id){
  await db.query(`UPDATE ${links} SET enabled=false WHERE workspace_id=$1 AND quote_id=$2 AND enabled`,[ctx.workspaceId,id]);
  await db.query(`UPDATE ${receipts} SET state='WITHDRAWN',problem='The business withdrew the quotation.',processed_at=now()
    WHERE workspace_id=$1 AND quote_id=$2 AND state IN('RECEIVED','HELD')`,[ctx.workspaceId,id]);
}
async function revoke(database,ctx,id,{linkRevision}){
  return tx(database,async db=>{
    await source.owner(db,ctx,{lock:true});
    await quotes.get(db,ctx.workspaceId,id,{lock:true});
    const link=await linked(db,ctx.workspaceId,id,{lock:true});
    if(!link||link.revision!==Number(linkRevision))throw new ValidationError('The private link changed. Reload its current status before withdrawing it.');
    if(!link.enabled)return {replayed:true};
    await revokeInTransaction(db,ctx,id);
    await audit.record(db,ctx,{action:'Withdrew a private quotation link',reference:id,after:{linkId:link.id,revision:link.revision}});
  });
}

async function lookup(db,token,{lock=false}={}){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw source.unavailable();
  const digest=tokenHash(token);
  const hit=(await db.query('SELECT workspace_id,quote_id FROM '+links+' WHERE token_hash=$1 AND enabled',[digest])).rows[0];
  if(!hit)throw source.unavailable();
  const q=await quotes.get(db,hit.workspace_id,hit.quote_id,{lock});
  const link=await linked(db,hit.workspace_id,hit.quote_id,{lock});
  if(!link?.enabled||link.token_hash!==digest)throw source.unavailable();
  const ctx={workspaceId:hit.workspace_id,actorId:link.published_by};
  const receipt=await accepted(db,ctx.workspaceId,q.id,{lock});
  return {ctx,q,link,receipt};
}

async function buyerPage(database,token){
  return database.transaction(async db=>{
    const {ctx,q,link,receipt}=await lookup(db,token);
    await source.owner(db,ctx);
    if(receipt&&receipt.state!=='WITHDRAWN')return {receipt:{quoteNumber:q.quote_number,acceptedAt:receipt.accepted_at}};
    await source.access(db,ctx);
    await exact(db,ctx,q,link);
    return {offer:source.publicOffer(q,link.offer),offerHash:link.offer_hash};
  },{isolation:'REPEATABLE READ',retrySafe:true});
}

async function receive(database,token,input){
  return tx(database,async db=>{
    const {ctx,q,link,receipt}=await lookup(db,token,{lock:true});
    const name=typeof input.buyerName==='string'?input.buyerName.trim():'';
    const email=typeof input.buyerEmail==='string'?source.normalizeEmail(input.buyerEmail):'';
    if(input.confirmed!=='yes'||input.expectedOffer!==link.offer_hash||!name||name.length>160||
      /[\u0000-\u001f\u007f]/.test(name)||email!==link.offer.source.email){
      throw new ValidationError('Enter your name, use the email address on the quotation and confirm the exact terms.',{buyerInput:true});
    }
    await source.owner(db,ctx);
    const fingerprint=acceptanceHash(link,name,email);
    if(receipt){
      if(receipt.acceptance_hash!==fingerprint||receipt.state==='WITHDRAWN')throw source.unavailable();
      return {id:receipt.id,replayed:true};
    }
    const state=await source.access(db,ctx,{lock:true});
    await exact(db,ctx,q,link,{lockPricing:true});
    const id=newId('buyer-acceptance');
    await storage.reserve(db,ctx.workspaceId,'buyer-acceptance:'+id,4096,{finished:true});
    await db.query(`INSERT INTO ${receipts}(id,workspace_id,quote_id,link_id,link_revision,offer_hash,buyer_name,buyer_email,acceptance_hash,payment_terms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [id,ctx.workspaceId,q.id,link.id,link.revision,link.offer_hash,name,email,fingerprint,JSON.stringify(link.offer.paymentTerms)]);
    if(link.routine&&policy.permits(state.plan,source.JOB,'automatic')){
      await require('../operations/postgres-job-queue').enqueue(scoped(db),{workspaceId:ctx.workspaceId,kind:KIND,
        idempotencyKey:'buyer-acceptance:'+id,payload:{quoteId:q.id,acceptanceId:id},maxAttempts:8,priority:55});
    }
    return {id};
  });
}

function checkReceipt(link,receipt,expected){
  if(!link?.enabled||!receipt||receipt.state==='WITHDRAWN'||receipt.link_id!==link.id||receipt.link_revision!==link.revision||
    receipt.offer_hash!==link.offer_hash||receipt.buyer_email!==link.offer.source.email||
    receipt.acceptance_hash!==acceptanceHash(link,receipt.buyer_name,receipt.buyer_email)||
    pricing.hash(receipt.payment_terms)!==pricing.hash(link.offer.paymentTerms)||
    expected&&(receipt.id!==expected.buyerAcceptanceId||receipt.acceptance_hash!==expected.acceptanceHash)){
    throw new ValidationError('Review the buyer’s exact acceptance of this private quotation.');
  }
}

async function build(db,ctx,q,link){
  await source.access(db,ctx);
  const receipt=await accepted(db,ctx.workspaceId,q.id);
  checkReceipt(link,receipt);
  await exact(db,ctx,q,link);
  const offer=source.publicOffer(q,link.offer);
  return {payload:{recordId:q.id,reviewedHash:q.pricing_hash,buyerAcceptanceId:receipt.id,acceptanceHash:receipt.acceptance_hash,
    buyerName:receipt.buyer_name,buyerEmail:receipt.buyer_email,acceptedAt:receipt.accepted_at,offer},
  summary:'Create one draft order for '+q.quote_number+', accepted by '+receipt.buyer_name+' at the quoted total.'};
}

async function apply(db,ctx,q,link,receipt,{automatic=false,expected=null}={}){
  await source.access(db,ctx,{automatic,stop:true,lock:true});
  if(receipt?.state==='DRAFTED'&&(!expected||receipt.id===expected.buyerAcceptanceId&&receipt.acceptance_hash===expected.acceptanceHash)){
    return {salesOrderId:receipt.order_id,replayed:true};
  }
  checkReceipt(link,receipt,expected);
  if(expected&&expected.reviewedHash!==q.pricing_hash)throw new ValidationError('Review the exact saved quotation again.');
  if(automatic&&(!link.routine||link.published_by!==ctx.actorId||Number(link.maximum_minor)<q.pricing.totalMinor)){
    throw new ValidationError('The owner’s routine scope no longer covers the accepted quotation.');
  }
  const {source:current,live}=await exact(db,ctx,q,link,{lockPricing:true});
  const input={...q.input,currency:q.pricing.currency,deliveryMethod:current.deliveryMethod,shipToAddress:current.shippingAddress,
    customerEmail:current.email,customerPhone:current.phone};
  await storage.reserve(db,ctx.workspaceId,'accepted-quote-order:'+receipt.id,Buffer.byteLength(JSON.stringify(q.pricing))*4+16384,{finished:true});
  const result=await quotes.completeAcceptance(db,ctx,q,input,pricing.quoteHash(live));
  await db.query(`UPDATE ${receipts} SET state='DRAFTED',order_id=$3,authorized_by=$4,approved_mode=$5,problem=NULL,processed_at=now()
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,receipt.id,result.salesOrderId,ctx.actorId,automatic?'ROUTINE':'INDIVIDUAL']);
  await audit.record(db,ctx,{action:'Drafted an order from a buyer acceptance',reference:q.id,
    after:{acceptanceId:receipt.id,orderId:result.salesOrderId,mode:automatic?'ROUTINE':'INDIVIDUAL'}});
  return result;
}

async function approve(db,ctx,expected){
  const q=await quotes.get(db,ctx.workspaceId,expected.recordId,{lock:true});
  const link=await linked(db,ctx.workspaceId,q.id,{lock:true}),receipt=await accepted(db,ctx.workspaceId,q.id,{lock:true});
  return apply(db,ctx,q,link,receipt,{expected});
}

async function run(database,workspaceId,{quoteId,acceptanceId}){
  return tx(database,async db=>{
    const q=await quotes.get(db,workspaceId,quoteId,{lock:true});
    const link=await linked(db,workspaceId,quoteId,{lock:true}),receipt=await accepted(db,workspaceId,quoteId,{lock:true});
    if(!receipt||receipt.id!==acceptanceId)return {state:'MISSING'};
    if(receipt.state!=='RECEIVED')return {state:receipt.state,salesOrderId:receipt.order_id,replayed:true};
    await db.query('SAVEPOINT accepted_quotation');
    try{
      const result=await apply(db,{workspaceId,actorId:link?.published_by},q,link,receipt,{automatic:true});
      await db.query('RELEASE SAVEPOINT accepted_quotation');
      return {state:'DRAFTED',...result};
    }catch(error){
      if(!expectedError(error))throw error;
      await db.query('ROLLBACK TO SAVEPOINT accepted_quotation');
      await db.query(`UPDATE ${receipts} SET state='HELD',problem=$3,processed_at=now() WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,receipt.id,error.message]);
      return {state:'HELD'};
    }
  });
}

async function page(db,ctx,id){
  await source.owner(db,ctx);
  const q=await quotes.get(db,ctx.workspaceId,id);
  const link=await linked(db,ctx.workspaceId,id),receipt=await accepted(db,ctx.workspaceId,id);
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=policy.usesAgentTerms(state)?state.plan:null;
  let current=null,problem=null;
  const canInspect=!receipt||['RECEIVED','HELD'].includes(receipt.state);
  if(canInspect){
    try{
      await source.access(db,ctx);
      current=receipt?await exact(db,ctx,q,link):await source.currentQuote(db,ctx,q);
    }catch(error){if(!expectedError(error))throw error;problem=error.message;}
  }
  const preview=!receipt&&current&&{source:current.source,paymentTerms:paymentTerms.forQuote(await paymentTerms.forCustomer(db,ctx.workspaceId,q.customer_id))};
  const offer=link?.offer||preview;
  const visible=link?.enabled&&!receipt&&current&&pricing.hash(current.source)===pricing.hash(link.offer.source);
  const token=visible?credentials.decrypt(link.token_cipher):null;
  const origin=require('../config').connections.publicOrigin;
  return {q,link:link&&{enabled:link.enabled,revision:link.revision,routine:link.routine,maximum:link.maximum_minor},receipt,
    offer:offer&&source.publicOffer(q,offer),problem,canPublish:Boolean(preview&&!receipt),
    publication:preview&&{hash:pricing.hash(preview),email:preview.source.email,...source.publicOffer(q,preview)},
    canReview:Boolean(current&&link?.enabled&&['RECEIVED','HELD'].includes(receipt?.state)),
    automatic:policy.permits(mode,source.JOB,'automatic'),url:token?(origin&&/^https:\/\//.test(origin)?new URL('/customer/quote/'+token,origin).href:'/customer/quote/'+token):null};
}

module.exports={KIND,linked,accepted,publish,revoke,revokeInTransaction,buyerPage,receive,build,approve,run,page,expectedError};
