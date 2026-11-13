'use strict';

// Job 83: customers order by text message (SMS) or WhatsApp. (The simple B2B
// order page of the same job is agent-customer-order-pages.js.)
//
// The owner gives each channel the business's number on StockChief's text
// provider (notifications/text-order-providers.js). The provider sends every
// message to that number's private link; StockChief keeps the original and
// reads it in the worker:
//  - the sender is one known customer, by the phone on their record;
//  - every line is a product (our code, the customer's own code, a barcode or
//    the exact product name) and a quantity in units;
//  - a written price must be the customer's price, a written delivery address
//    one already on file.
// Anything unknown or unclear stops before any order exists and waits in Needs
// you. Otherwise the message becomes a customer order through the ordinary
// sales order services. Pro prepares a draft for approval until it is taught,
// by a saved rule for the customer or by a text order from them that a person
// confirmed; then, like Custom, it creates and confirms the order on its own
// through the normal confirmation, within the owner's customer order limits
// (shared with jobs 52 and 53). A customer's first order, an order over a
// limit, Ask me first and a credit or address problem leave a prepared draft.
// The first 14 days, Watch only and pause only watch and record what StockChief
// would have done. Each message makes at most one order, every order is
// audited, and Undo cancels a confirmed order through the ordinary path.
// StockChief answers the customer once, from the same number.

const {randomBytes}=require('node:crypto');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const promotions=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const orders=require('./agent-customer-orders');
const providers=require('../notifications/text-order-providers');

const JOB=83,kind='customer.text-order.v1',path='/autopilot/text-orders',publicPath='/integrations/stockchief/text-orders';
const lines='stockchief_runtime.agent_text_order_lines',texts='stockchief_runtime.agent_customer_text_orders',rules='stockchief_runtime.agent_text_order_rules';
const CHANNELS={SMS:'Text message',WHATSAPP:'WhatsApp'};
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const expected=error=>error instanceof DomainError||[400,402,403,404,409,422].includes(error?.status);
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const uncertain=detail=>new ValidationError(detail);
const CREATED='Customer order from text created and confirmed by StockChief',PREPARED='Customer order from text prepared by StockChief for approval';

// --- Reading the message ---------------------------------------------------

const greeting=/^(?:hello|hi|hey|dear|good (?:morning|afternoon|evening))(?:\s+[\p{L}.'-]+){0,3}[!.,]*$/iu;
const signOff=/^(?:thanks|thank you|thx|ty|many thanks|regards|best|best regards|kind regards|cheers|sincerely)(?:\s+(?:again|so much|a lot))?(?:[!.,]+(?:\s*[\p{L}.'-]+){0,3})?[!.,]*$/iu;
const shipToLine=/^(?:ship(?:ping)?[\s-]+to|deliver(?:y)?\s+to|delivery\s+address|shipping\s+address)\s*[:-]?\s*(.*)$/i;
const referenceLine=/^(?:(?:our|my)\s+)?(?:po|p\.o\.|purchase order|order ref(?:erence)?|ref(?:erence)?)\s*(?:#|no\.?|number|:)?\s*([\w.-]{1,60})$/i;
const pickupLine=/^(?:customer pickup|pickup|pick up|pick it up|we will collect|we'll collect|will collect|collecting)$/i;
const request=/^(?:please\s+|pls\s+|plz\s+)?(?:can|could)\s+(?:i|we|you)\s+(?:get|have|send(?:\s+(?:us|me))?)\s+|^(?:please\s+|pls\s+|plz\s+)?(?:i(?:'d|’d| would) like|we(?:'d|’d| would) like|i need|we need|need|send(?:\s+(?:us|me))?|order|add|i want|we want)\s+|^(?:please|pls|plz)\s+/i;
const PRICE=String.raw`(?:\s*(?:@|at|for)\s*(?<price>(?:[A-Z]{3}\s?|[$€£])?\d+(?:[.,]\d{1,4})?)(?:\s*(?:each|ea\.?|per unit|/\s*(?:unit|ea)))?)?`;
const quantityFirst=new RegExp(String.raw`^(?<qty>\d+(?:\.\d+)?)\s*(?:[x×*]\s*)?(?:(?:units?|pcs|pieces|ea|each)\s+)?(?:of\s+)?(?<what>.+?)`+PRICE+'$','iu');
const quantityLast=new RegExp(String.raw`^(?<what>.+?)\s*(?:[x×*]|qty\.?\s*:?|-|:)\s*(?<qty>\d+(?:\.\d+)?)(?:\s*(?:units?|pcs|pieces))?`+PRICE+'$','iu');
const codeThenQuantity=new RegExp(String.raw`^(?<what>[\w./-]+)\s+(?<qty>\d+(?:\.\d+)?)`+PRICE+'$','iu');
const packWords=/^(?<pack>boxes|box|cases?|packs?|cartons?|pallets?|dozens?|bags?|rolls?|crates?)\s+(?:of\s+)?(?<rest>.+)$/i;

// Every part of the message must be part of the order. A note or a second
// instruction must never silently become a quantity or disappear.
function readText(body){
  const text=String(body||'').replace(/\r/g,'').trim();
  if(!text)throw uncertain('The message is empty.');
  const out={reference:null,pickup:false,shipTo:null,lines:[]},seen=new Set();
  const parts=[];
  for(const raw of text.split('\n')){
    const line=raw.trim();if(!line)continue;
    if(shipToLine.test(line)){parts.push(line);continue;}
    parts.push(...line.split(/\s*[;,]\s*|(?<=[.!?])\s+|\s+(?:and|&|\+)\s+(?=\d)/i));
  }
  for(const raw of parts){
    const part=raw.trim().replace(/[.!?]+$/,'').trim();
    if(!part)continue;
    if(signOff.test(part))break;
    if(greeting.test(part))continue;
    const ref=referenceLine.exec(part);
    if(ref){
      if(out.reference&&out.reference.toLowerCase()!==ref[1].toLowerCase())throw uncertain('The message names two purchase order numbers.');
      out.reference=ref[1];continue;
    }
    if(pickupLine.test(part)){out.pickup=true;continue;}
    const ship=shipToLine.exec(part);
    if(ship){
      if(!ship[1].trim())throw uncertain('The delivery address is empty.');
      if(out.shipTo&&out.shipTo.toLowerCase()!==ship[1].trim().toLowerCase())throw uncertain('The message names two delivery addresses.');
      out.shipTo=ship[1].trim();continue;
    }
    const item=part.replace(request,'').trim();
    // "12 x 345" reads both ways when a code is all digits: keep only a
    // reading with a plausible quantity, or ask.
    const first=quantityFirst.exec(item),last=quantityLast.exec(item)||codeThenQuantity.exec(item);
    const plausible=m=>Boolean(m)&&Number(m.groups.qty)>0&&Number(m.groups.qty)<=100000&&!/^0\d/.test(m.groups.qty)&&Boolean(m.groups.what.trim());
    const digits=m=>/^\d+$/.test(m.groups.what.trim());
    if(plausible(first)&&digits(first)&&plausible(last))throw uncertain('“'+part.slice(0,120)+'” can be read more than one way.');
    const chosen=plausible(first)?first:plausible(last)?last:null;
    if(!chosen)throw uncertain('StockChief could not read “'+part.slice(0,120)+'” as a product and a quantity.');
    const found=chosen.groups,what=found.what.trim().replace(/^of\s+/i,'');
    if(!what||what.length>120||out.lines.length>=100)throw uncertain('Review the line “'+part.slice(0,120)+'”.');
    if(seen.has(what.toLowerCase()))throw uncertain('“'+what.slice(0,80)+'” appears twice.');
    seen.add(what.toLowerCase());
    out.lines.push({what,quantity:found.qty,price:found.price?found.price.trim():null,raw:part.slice(0,200)});
  }
  if(!out.lines.length)throw uncertain('StockChief found no products and quantities in this message.');
  if(out.pickup&&out.shipTo)throw uncertain('The message asks for both pickup and delivery.');
  return out;
}

const spoken=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const singular=value=>value.replace(/(?:es|s)$/,'');

// One product for what the customer wrote: our code, their own code, a barcode
// or the exact product name. Unknown or more than one is a question.
async function product(c,workspaceId,customerId,what){
  try{
    const [sku]=[...(await orders.identify(c,workspaceId,customerId,[what])).values()];
    return (await details(c,workspaceId,[sku.id]))[0];
  }catch(error){
    if(!(error instanceof ValidationError)||!/does not know the product code/.test(error.message))throw uncertain(error.message);
  }
  const name=spoken(what);
  if(!name)throw uncertain('StockChief does not know the product “'+what.slice(0,80)+'”.');
  const names=[...new Set([name,singular(name)])];
  const rows=(await c.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
      AND (btrim(regexp_replace(lower(i.name),'[^[:alnum:]]+',' ','g'))=ANY($2::text[])
        OR btrim(regexp_replace(lower(i.name||' '||coalesce(s.variant_label,'')),'[^[:alnum:]]+',' ','g'))=ANY($2::text[]))
    LIMIT 3`,[workspaceId,names])).rows;
  if(rows.length===1)return (await details(c,workspaceId,[rows[0].id]))[0];
  const pack=packWords.exec(what);
  if(pack&&!rows.length){
    const inner=await product(c,workspaceId,customerId,pack.groups.rest).catch(()=>null);
    if(inner&&singular(spoken(inner.unit_label))===singular(spoken(pack.groups.pack)))return inner;
    throw uncertain('StockChief cannot tell how many units “'+what.slice(0,80)+'” is. A person checks the quantity.');
  }
  if(rows.length>1)throw uncertain('“'+what.slice(0,80)+'” matches more than one product.');
  throw uncertain('StockChief does not know the product “'+what.slice(0,80)+'”. Add it as this customer’s own code on Customer orders from email, or enter the order yourself.');
}
async function details(c,workspaceId,ids){
  return (await c.query(`SELECT s.id,s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.quantity_increment,i.secondary_unit_label
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])`,[workspaceId,ids])).rows;
}

// The customers whose phone on record is this number. Numbers kept without
// their country code (a national number) match its end.
async function customersFor(c,workspaceId,sender){
  const digits=sender.replace(/\D/g,'');
  return (await c.query(`SELECT c.id,c.name,c.company,c.shipping_address FROM customers c
    CROSS JOIN LATERAL (SELECT regexp_replace(c.phone,'[^0-9]','','g') AS d,btrim(c.phone) LIKE '+%' AS international) p
    CROSS JOIN LATERAL (SELECT CASE WHEN p.international THEN p.d WHEN p.d LIKE '00%' THEN substr(p.d,3) ELSE regexp_replace(p.d,'^0','') END AS key) k
    WHERE c.workspace_id=$1 AND c.record_state='ACTIVE' AND c.phone IS NOT NULL
      AND (k.key=$2 OR (NOT p.international AND p.d NOT LIKE '00%' AND length(k.key)>=9 AND right($2,length(k.key))=k.key))
    ORDER BY c.id LIMIT 3`,[workspaceId,digits])).rows;
}

// The exact order this message asks for, and anything a person must check.
async function review(c,ctx,row){
  await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
  const entitlements=require('../commercial/entitlements');
  await entitlements.assertCapability(c,await entitlements.ownerScopeForWorkspace(c,ctx.workspaceId),'sales_orders.core');
  if(row.media_count>0)throw uncertain('The customer sent a picture or file with this message. StockChief reads only the words, so a person enters this order.');
  const customers=await customersFor(c,ctx.workspaceId,row.sender);
  if(!customers.length)throw uncertain('StockChief does not know the number '+row.sender+'. Add it to the customer’s record, then read the message again.');
  if(customers.length>1)throw uncertain('The number '+row.sender+' is on more than one customer: '+customers.slice(0,2).map(x=>x.name).join(' and ')+'.');
  const customer=customers[0],parsed=readText(row.body),found=[];
  for(const line of parsed.lines){
    const sku=await product(c,ctx.workspaceId,customer.id,line.what);
    try{require('../domain/stock-quantity').validate(sku,line.quantity,{label:'Quantity for '+sku.code});}
    catch{throw uncertain('“'+line.raw+'” is not a quantity of '+sku.name+' StockChief can order.');}
    found.push(sku);
  }
  const skuLines=parsed.lines.map((line,i)=>({skuId:found[i].id,quantity:Number(line.quantity)}));
  if(new Set(skuLines.map(l=>l.skuId)).size!==skuLines.length)throw uncertain('The message lists the same product twice.');
  let address=null,newAddress=false;
  if(!parsed.pickup){
    if(parsed.shipTo){
      const known=(await require('./postgres-email-order').addressesOnFile(c,ctx.workspaceId,customer)).find(a=>spoken(a)===spoken(parsed.shipTo));
      address=known||parsed.shipTo;newAddress=!known;
    }else if(customer.shipping_address)address=customer.shipping_address;
    else throw uncertain('Add a delivery address to '+customer.name+' before creating the order.');
  }
  const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  const input={customerId:customer.id,reference:parsed.reference,currency,deliveryMethod:parsed.pickup?'PICKUP':'SHIP',
    ...(parsed.shipTo&&address?{shipToAddress:address}:{}),lines:skuLines,
    notes:'Ordered by '+CHANNELS[row.channel]+' from '+row.sender+'.',idempotencyKey:'customer-order-text:'+row.id};
  const quote=await promotions.prepareQuote(c,ctx,input);
  await require('./agent-customer-pricing').checkOrder(c,ctx,input,quote);
  if(quote.violations.length)throw uncertain('Review the current selling prices and pricing safeguards before creating this order.');
  const problems=[];
  for(const [index,line] of parsed.lines.entries()){
    if(!line.price)continue;
    const priced=quote.lines[index],sku=found[index];
    let stated;
    try{stated=money.userToMinor(line.price.replace(/^([$€£]?\d+),(\d{1,2})$/,'$1.$2'),currency);}
    catch{problems.push(sku.code+': StockChief could not read the price “'+line.price+'” in '+currency+'.');continue;}
    if(stated!==Number(priced.unitPriceMinor)&&Math.round(stated*Number(priced.quantity))!==Number(priced.netMinor))
      problems.push(sku.code+': the customer wrote '+money.format(stated,currency)+'; your price is '+money.format(Number(priced.unitPriceMinor),currency)+'.');
  }
  if(newAddress)problems.push('New delivery address: '+address+'. A person checks new addresses.');
  input.pricingQuoteHash=promotions.quoteHash(quote);
  const digest=promotions.hash({input,address,sender:row.sender,body:row.body});
  return {input,quote,customer,problems,address,digest,skus:found};
}

// --- Training and authority -----------------------------------------------

// Pro is taught by a saved rule for the customer, or by an earlier text order
// from them that StockChief prepared and a person confirmed. A rule the owner
// turned off keeps every order from that customer for a person.
async function ruleFor(c,workspaceId,customerId){
  const rule=(await c.query(`SELECT r.enabled FROM ${rules} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.customer_id=$2`,[workspaceId,customerId])).rows[0];
  return rule?rule.enabled:null;
}
async function taught(c,workspaceId,customerId){
  const rule=await ruleFor(c,workspaceId,customerId);
  if(rule!==null)return rule;
  return (await c.query(`SELECT 1 FROM ${texts} t JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id
    WHERE t.workspace_id=$1 AND t.customer_id=$2 AND NOT t.automatic AND t.status='DRAFTED' AND o.status=ANY($3::text[]) LIMIT 1`,
  [workspaceId,customerId,orders.CONFIRMED])).rowCount>0;
}
const UNTAUGHT='You have not taught StockChief this customer’s text orders yet, so it waits for your approval. Confirm one, or save a rule for them.';

async function record(c,workspaceId,id,fields){
  await c.query(`UPDATE ${texts} SET customer_id=coalesce($3,customer_id),status=$4,reason=$5,sales_order_id=coalesce($6,sales_order_id),automatic=$7,
      total_minor=coalesce($8,total_minor),currency=coalesce($9,currency),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2 AND (sales_order_id IS NULL OR $6::text IS NOT NULL)`,
  [workspaceId,id,fields.customerId||null,fields.status,fields.reason||null,fields.salesOrderId||null,Boolean(fields.automatic),fields.totalMinor??null,fields.currency||null]);
}

async function load(c,workspaceId,id,{lock=false}={}){
  const row=(await c.query(`SELECT * FROM ${texts} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That text order is not in this inventory.');
  return row;
}

// StockChief creates the order for the agent (agent:true): on its own within
// the owner's authority, or as a draft for approval. A person may prepare the
// draft from the review instead (digest), for example at the business's own
// price after the customer wrote another.
async function create(db,ctx,id,{agent=false,digest=null}={}){
  return tx(db,async c=>{
    const row=await load(c,ctx.workspaceId,id,{lock:true});
    if(row.sales_order_id){
      const o=(await c.query('SELECT order_number FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.sales_order_id])).rows[0];
      return {salesOrderId:row.sales_order_id,orderNumber:o?.order_number,replayed:true,status:row.status};
    }
    if(['STOPPED','UNDONE'].includes(row.status))throw new ValidationError('This message was dismissed.');
    let decision=null,result;
    if(agent){
      const matches=await customersFor(c,ctx.workspaceId,row.sender);
      decision=await orders.decide(c,ctx.workspaceId,JOB,{trained:matches.length===1&&await taught(c,ctx.workspaceId,matches[0].id),untaught:UNTAUGHT});
      if(decision.mode==='skip')throw new ValidationError('Orders by text and WhatsApp need the Pro plan or above.');
      // Shadow, Watch only and pause: record what StockChief would have done.
      if(decision.mode==='watch'){
        try{result=await review(c,ctx,row);}
        catch(inner){if(!expected(inner))throw inner;throw Object.assign(new ValidationError(decision.reason+' It would have asked you: '+inner.message),{watch:true});}
        throw Object.assign(new ValidationError(decision.reason+(result.problems.length?' It would have asked you: '+result.problems.join(' '):
          ' It would have prepared '+result.customer.name+'’s order for '+money.format(result.quote.totalMinor,result.input.currency)+'.')),{watch:true,customerId:result.customer.id});
      }
      result=await review(c,ctx,row);
      if(result.problems.length)throw Object.assign(new ValidationError(result.problems.join(' ')),{customerId:result.customer.id});
    }else{
      const owner=(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount;
      if(!owner)throw new AuthorizationError('Only the business owner can prepare orders from text messages.');
      result=await review(c,ctx,row);
      if(result.digest!==digest)throw new ValidationError('The order details changed. Review the current message before preparing it.');
    }
    const {input,quote}=result;
    const gate=!agent?null:decision.mode!=='automatic'?decision.reason:
      await ruleFor(c,ctx.workspaceId,input.customerId)===false?'You asked StockChief to wait for you on every text order from this customer.':
      !decision.limit?'Save your limits for customer orders before StockChief confirms text orders on its own.':
      await orders.needsPerson(c,ctx.workspaceId,input.customerId,{pickup:input.deliveryMethod==='PICKUP',address:result.address})||
      orders.overLimit(decision.limit,{currency:input.currency,totalMinor:quote.totalMinor,units:orders.units(input.lines)});
    if(input.reference){
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,input.customerId,input.reference.toLowerCase()])]);
      if((await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,input.customerId,input.reference])).rowCount)
        throw new ValidationError('An order already uses this customer purchase order number. Check it before creating another.');
    }
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'customer-text-order-draft:'+id,Buffer.byteLength(JSON.stringify(input))*2+16384,{finished:true});
    const created=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,input);
    const automatic=agent&&!gate;
    const confirmed=automatic?await orders.confirm(c,ctx,created.salesOrderId,'customer-order-text-confirm:'+id):null;
    const status=confirmed&&!confirmed.held?'CONFIRMED':'DRAFTED';
    const reason=confirmed?.held?'StockChief created this order but did not confirm it. '+confirmed.held:gate;
    await record(c,ctx.workspaceId,id,{customerId:input.customerId,status,reason,salesOrderId:created.salesOrderId,automatic,totalMinor:quote.totalMinor,currency:input.currency});
    await audit(c,ctx,{action:status==='CONFIRMED'?CREATED:agent?PREPARED:'Customer order from text drafted',reference:created.orderNumber,
      after:{textOrderId:id,channel:row.channel,sender:row.sender,customerId:input.customerId,reference:input.reference||null,totalMinor:quote.totalMinor,
        currency:input.currency,lines:input.lines,deliveryMethod:input.deliveryMethod,address:result.address,status:confirmed?.status||'DRAFT',
        automatic,reason:reason||null}});
    return {...created,status:confirmed?.status||'DRAFT',automatic,...(reason?{reason}:{})};
  });
}

// --- The worker --------------------------------------------------------------

async function handle(db,workspaceId,id){
  const limit=await orders.limits(db,workspaceId);
  const actorId=limit?.authorizedBy||await orders.ownerUser(db,workspaceId);
  if(!actorId)return {skipped:true};
  const ctx={workspaceId,actorId};
  try{return await create(db,ctx,id,{agent:true});}
  catch(error){
    if(!expected(error))throw error;
    const reason=error.message;
    let customerId=error.customerId||null;
    if(!customerId){
      const matches=await customersFor(db,workspaceId,(await load(db,workspaceId,id)).sender);
      if(matches.length===1)customerId=matches[0].id;
    }
    await db.transaction(c=>record(c,workspaceId,id,{customerId,status:error.watch?'WATCHED':'HELD',reason}));
    return {held:true,watched:Boolean(error.watch),reason};
  }
}

// One answer to the customer, from the same number: confirmed with its number
// and total, or received and waiting for a person. A number StockChief does
// not know, and anything it only watched, gets no answer. A message whose
// delivery is uncertain is never sent again.
async function reply(db,workspaceId,id,{send}={}){
  const claim=await db.transaction(async c=>{
    const row=(await c.query(`SELECT t.*,l.number AS line_number,o.order_number FROM ${texts} t JOIN ${lines} l ON l.workspace_id=t.workspace_id AND l.id=t.line_id
      LEFT JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id WHERE t.workspace_id=$1 AND t.id=$2 FOR UPDATE OF t`,[workspaceId,id])).rows[0];
    if(!row||row.reply_status!=='NONE'||!row.customer_id||!['CONFIRMED','DRAFTED','HELD'].includes(row.status))return null;
    const state=await policy.accountState(c,workspaceId);
    if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return null;
    const body=row.status==='CONFIRMED'?'Thank you. Order '+row.order_number+' is confirmed: '+money.format(Number(row.total_minor),row.currency)+'. We will let you know when it ships.':
      'Thank you, we received your order. We will confirm it shortly.';
    const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(c,workspaceId);
    await require('../commercial/control-service').recordCost(c,scope,{
      provider:'twilio',operation:'customer_text_order_reply',unit:'submission',quantity:1,
      idempotencyKey:'customer-text-order-reply:'+id,detail:{channel:row.channel}
    });
    await c.query(`UPDATE ${texts} SET reply_status='SENDING',reply_body=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,body]);
    return {row,body};
  });
  if(!claim)return null;
  const {row,body}=claim;
  try{
    const sent=await (send||providers.send)({channel:row.channel,from:row.line_number,to:row.sender,body});
    await db.query(`UPDATE ${texts} SET reply_status='SENT',reply_reference=$3 WHERE workspace_id=$1 AND id=$2 AND reply_status='SENDING'`,
      [workspaceId,id,String(sent?.reference||'').slice(0,300)||null]);
    return {sent:true};
  }catch(error){
    const status=Number(error?.status)||0,uncertainOutcome=Boolean(error?.providerOutcomeUncertain)||!status;
    await db.query(`UPDATE ${texts} SET reply_status=$3,reply_error=$4 WHERE workspace_id=$1 AND id=$2 AND reply_status='SENDING'`,
      [workspaceId,id,uncertainOutcome?'UNCERTAIN':'FAILED',String(error?.message||'The text provider refused the message.').slice(0,500)]);
    return {sent:false,reason:String(error?.message||'')};
  }
}

async function process(db,workspaceId,id,{send}={}){
  if(!await has(db,texts))return {skipped:'upgrade'};
  const row=(await db.query(`SELECT status FROM ${texts} WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
  if(!row)return {skipped:'missing'};
  const result=row.status==='RECEIVED'?await handle(db,workspaceId,id):{replayed:true,status:row.status};
  await reply(db,workspaceId,id,{send});
  return result;
}

// --- The provider's link -------------------------------------------------------

// A message the provider signed for one business's number. It is kept as it
// came and read in the worker. A repeated delivery changes nothing.
async function receive(db,endpoint,request,{settings}={}){
  if(typeof endpoint!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(endpoint))throw new NotFoundError('This text order link is unavailable.');
  if(!await has(db,lines))throw new NotFoundError('This text order link is unavailable.');
  const line=(await db.query(`SELECT l.* FROM ${lines} l JOIN workspaces w ON w.id=l.workspace_id AND w.deletion_requested_at IS NULL
    WHERE l.endpoint=$1 AND l.enabled`,[endpoint])).rows[0];
  if(!line)throw new NotFoundError('This text order link is unavailable.');
  const message=providers.read(request,settings);
  if(message.channel!==line.channel||message.to!==line.number)throw new AuthorizationError('This message was sent to another number.');
  const state=await policy.accountState(db,line.workspace_id);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {ignored:'plan'};
  return db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['text-order:'+line.workspace_id+':'+message.from]);
    const prior=(await c.query(`SELECT id FROM ${texts} WHERE workspace_id=$1 AND channel=$2 AND provider_reference=$3`,
      [line.workspace_id,message.channel,message.reference])).rows[0];
    if(prior)return {id:prior.id,replayed:true};
    // A flood from one number, or a full queue, waits for the business.
    const recent=(await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM ${texts} WHERE workspace_id=$1 AND sender=$2
      AND created_at>clock_timestamp()-interval '1 hour' LIMIT 30) r`,[line.workspace_id,message.from])).rows[0].n;
    const waiting=(await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM ${texts} WHERE workspace_id=$1
      AND status IN ('RECEIVED','HELD','WATCHED') LIMIT 1000) r`,[line.workspace_id])).rows[0].n;
    if(recent>=30||waiting>=1000)return {ignored:'busy'};
    const id=newId('textorder');
    await require('../commercial/storage-capacity').reserve(c,line.workspace_id,'customer-text-order:'+id,Buffer.byteLength(message.body)+8192,{finished:true});
    await c.query(`INSERT INTO ${texts}(workspace_id,id,line_id,channel,provider_reference,sender,body,media_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [line.workspace_id,id,line.id,message.channel,message.reference,message.from,message.body,message.media]);
    await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:line.workspace_id,kind,idempotencyKey:id,payload:{id},maxAttempts:3,priority:60});
    return {id};
  });
}

// --- The owner's settings ------------------------------------------------------

async function requireOwner(db,ctx){
  if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('Only the business owner can change how StockChief takes orders by text.');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
}
function phoneNumber(value){
  const number=String(value||'').trim().replace(/^00/,'+').replace(/[\s().-]/g,'');
  if(!providers.NUMBER.test(number))throw new ValidationError('Enter the number with its country code, for example +15185550100.');
  return number;
}

// The business's number on a channel. Saving it again keeps its link; turning
// it off stops reading new messages.
async function saveLine(db,ctx,input){
  return tx(db,async c=>{
    await requireOwner(c,ctx);
    const channel=String(input.channel||'');
    if(!CHANNELS[channel])throw new ValidationError('Choose text message or WhatsApp.');
    const prior=(await c.query(`SELECT * FROM ${lines} WHERE workspace_id=$1 AND channel=$2 FOR UPDATE`,[ctx.workspaceId,channel])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('This number changed. Reload the page before saving.');
    const enabled=input.enabled!=='no',number=enabled||!prior?phoneNumber(input.number):prior.number;
    if(enabled&&(await c.query(`SELECT 1 FROM ${lines} WHERE channel=$1 AND number=$2 AND enabled AND NOT (workspace_id=$3 AND id=$4)`,
      [channel,number,ctx.workspaceId,prior?.id||''])).rowCount)
      throw new ValidationError('Another StockChief business already uses this number.');
    const id=prior?.id||newId('textline');
    if(prior)await c.query(`UPDATE ${lines} SET number=$3,enabled=$4,authorized_by=$5,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,number,enabled,ctx.actorId]);
    else{
      await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'text-order-line:'+id,4096,{finished:true});
      await c.query(`INSERT INTO ${lines}(workspace_id,id,channel,number,endpoint,enabled,authorized_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [ctx.workspaceId,id,channel,number,randomBytes(24).toString('base64url'),enabled,ctx.actorId]);
    }
    await audit(c,ctx,{action:'Text order number saved',reference:id,before:prior?{number:prior.number,enabled:prior.enabled}:{},after:{channel,number,enabled}});
    return {id,enabled};
  });
}

// A saved rule for one customer: take their text orders on its own (Pro is
// taught by it), or always ask.
async function saveRule(db,ctx,input){
  return tx(db,async c=>{
    await requireOwner(c,ctx);
    const customer=(await c.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,input.customerId])).rows[0];
    if(!customer)throw new ValidationError('Choose an active customer.');
    const enabled=input.enabled==='yes';
    const prior=(await c.query(`SELECT enabled FROM ${rules} WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE`,[ctx.workspaceId,customer.id])).rows[0];
    if(enabled&&!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    if(!prior)await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'text-order-rule:'+customer.id,2048,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,customer_id,enabled,authorized_by) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id,customer_id) DO UPDATE SET enabled=EXCLUDED.enabled,authorized_by=EXCLUDED.authorized_by,
        revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,customer.id,enabled,ctx.actorId]);
    await audit(c,ctx,{action:'Text order customer rule saved',reference:customer.id,before:prior?{enabled:prior.enabled}:{},after:{customer:customer.name,enabled}});
    return {enabled};
  });
}

// A person reads a held message again (after adding the customer's number or
// code), or dismisses it.
async function retry(db,ctx,id){
  await requireOwner(db,ctx);
  const changed=await db.query(`UPDATE ${texts} SET status='RECEIVED',reason=NULL,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2 AND status IN ('HELD','WATCHED') AND sales_order_id IS NULL`,[ctx.workspaceId,id]);
  if(!changed.rowCount)throw new ValidationError('Only a message that is waiting can be read again.');
  return handle(db,ctx.workspaceId,id);
}
async function dismiss(db,ctx,id){
  return tx(db,async c=>{
    await requireOwner(c,ctx);
    const row=await load(c,ctx.workspaceId,id,{lock:true});
    if(row.sales_order_id)throw new ValidationError('This message already has an order. Change or cancel the order instead.');
    if(row.status==='STOPPED')return {replayed:true};
    await c.query(`UPDATE ${texts} SET status='STOPPED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await audit(c,ctx,{action:'Text order message dismissed',reference:id,before:{status:row.status}});
    return {id};
  });
}
async function prepare(db,ctx,id,input){return create(db,ctx,id,{digest:String(input.digest||'')});}

// --- Pages ----------------------------------------------------------------

function origin(base){return String(require('../config').connections.publicOrigin||base||'').replace(/\/$/,'');}

async function page(db,ctx,{id=null,base=''}={}){
  const state=await requireOwner(db,ctx);
  const plan=state.plan,autopilot=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  const [saved,waiting,recent,taughtRows,customers,limit]=await Promise.all([
    db.query(`SELECT * FROM ${lines} WHERE workspace_id=$1 ORDER BY channel`,[ctx.workspaceId]).then(r=>r.rows),
    db.query(`SELECT t.*,c.name AS customer,o.order_number,o.status AS order_status FROM ${texts} t
      LEFT JOIN customers c ON c.workspace_id=t.workspace_id AND c.id=t.customer_id LEFT JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id
      WHERE t.workspace_id=$1 AND (t.status IN ('RECEIVED','HELD','WATCHED') OR t.status='DRAFTED' AND o.status='DRAFT') ORDER BY t.updated_at DESC,t.id LIMIT 50`,[ctx.workspaceId]).then(r=>r.rows),
    db.query(`SELECT t.*,c.name AS customer,o.order_number,o.status AS order_status FROM ${texts} t
      LEFT JOIN customers c ON c.workspace_id=t.workspace_id AND c.id=t.customer_id LEFT JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id
      WHERE t.workspace_id=$1 AND NOT (t.status IN ('RECEIVED','HELD','WATCHED') OR t.status='DRAFTED' AND o.status='DRAFT') ORDER BY t.updated_at DESC,t.id LIMIT 50`,[ctx.workspaceId]).then(r=>r.rows),
    db.query(`SELECT c.id,c.name,r.enabled,EXISTS(SELECT 1 FROM ${texts} t JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id
        WHERE t.workspace_id=c.workspace_id AND t.customer_id=c.id AND NOT t.automatic AND t.status='DRAFTED' AND o.status=ANY($2::text[])) AS example
      FROM customers c LEFT JOIN ${rules} r ON r.workspace_id=c.workspace_id AND r.customer_id=c.id
      WHERE c.workspace_id=$1 AND (r.customer_id IS NOT NULL OR EXISTS(SELECT 1 FROM ${texts} t WHERE t.workspace_id=c.workspace_id AND t.customer_id=c.id))
      ORDER BY lower(c.name),c.id LIMIT 200`,[ctx.workspaceId,orders.CONFIRMED]).then(r=>r.rows),
    db.query("SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' ORDER BY lower(name),id LIMIT 500",[ctx.workspaceId]).then(r=>r.rows),
    orders.limits(db,ctx.workspaceId)
  ]);
  const link=line=>origin(base)+publicPath+'/'+line.endpoint;
  const available=providers.available();
  const channels=Object.entries(CHANNELS).map(([channel,label])=>{const line=saved.find(l=>l.channel===channel);
    return {channel,label,available:available[channel],line:line?{...line,link:link(line)}:null};});
  const describe=r=>({id:r.id,who:r.customer||r.sender,channel:CHANNELS[r.channel],body:r.body,reason:r.reason,order:r.order_number,
    href:r.sales_order_id?'/orders/'+r.sales_order_id:path+'/'+r.id,
    label:r.status==='CONFIRMED'?'Confirmed on its own':r.status==='UNDONE'?'Undone':r.status==='STOPPED'?'Dismissed':
      r.status==='DRAFTED'?(r.order_status==='DRAFT'?'Draft waiting for you':'Approved'):r.status==='WATCHED'?'Watched only':r.status==='RECEIVED'?'Reading':'Needs you',
    amount:r.total_minor!=null&&r.currency?money.format(Number(r.total_minor),r.currency):null,
    canUndo:r.automatic&&r.status==='CONFIRMED'&&!['CANCELLED','FULFILLED','PARTIALLY_FULFILLED'].includes(r.order_status),at:r.updated_at});
  const stop=state.shadow?'StockChief is watching during its first 14 days. It records what it would do and creates nothing.':
    autopilot.mode==='OBSERVE'?'StockChief is set to Watch only.':autopilot.paused?'Automatic work is paused.':null;
  let selected=null;
  if(id){
    const row=await load(db,ctx.workspaceId,id);
    const extra=(await db.query(`SELECT c.name AS customer,o.order_number,o.status AS order_status FROM (SELECT 1) x
      LEFT JOIN customers c ON c.workspace_id=$1 AND c.id=$2 LEFT JOIN sales_orders o ON o.workspace_id=$1 AND o.id=$3`,
    [ctx.workspaceId,row.customer_id,row.sales_order_id])).rows[0];
    selected={...describe({...row,...extra}),status:row.status,sender:row.sender,reply:row.reply_status,replyBody:row.reply_body,canRetry:['HELD','WATCHED'].includes(row.status)&&!row.sales_order_id,
      canDismiss:['HELD','WATCHED','RECEIVED'].includes(row.status)&&!row.sales_order_id};
    if(selected.canRetry){
      try{const r=await db.transaction(c=>review(c,ctx,row));selected.review={customer:r.customer.name,digest:r.digest,problems:r.problems,
        total:money.format(r.quote.totalMinor,r.input.currency),address:r.address,lines:r.input.lines.map((l,i)=>({code:r.skus[i].code,name:r.skus[i].name,quantity:l.quantity}))};}
      catch(error){if(!expected(error))throw error;selected.unreadable=error.message;}
    }
  }
  return {plan,mode:policy.allowance(plan,JOB),stop,channels,waiting:waiting.map(describe),recent:recent.map(describe),
    taught:taughtRows.map(r=>({id:r.id,name:r.name,state:r.enabled===true?'rule':r.enabled===false?'ask':r.example?'example':'none'})),
    customers,limit:limit?{...limit,maximum:money.fromMinor(limit.maximumMinor,limit.currency)}:null,selected};
}

async function readPage(db,ctx,{page:number=1}={}){
  await requireOwner(db,ctx);
  if(!await has(db,texts))return {rows:[],more:false,summary:''};
  const rows=(await db.query(`SELECT t.id,t.sender,t.channel,t.status,t.reason,t.sales_order_id,c.name AS customer,o.order_number FROM ${texts} t
    LEFT JOIN customers c ON c.workspace_id=t.workspace_id AND c.id=t.customer_id LEFT JOIN sales_orders o ON o.workspace_id=t.workspace_id AND o.id=t.sales_order_id
    WHERE t.workspace_id=$1 ORDER BY t.updated_at DESC,t.id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(Math.max(1,Number(number)||1)-1)*100])).rows;
  return {rows:rows.slice(0,100).map(r=>({Customer:r.customer||r.sender,Reference:CHANNELS[r.channel],Order:r.order_number||'',Status:r.status.toLowerCase(),Review:r.reason||'',
    link:r.sales_order_id?'/orders/'+r.sales_order_id:path+'/'+r.id})),more:rows.length>100,
    summary:'Customer orders sent by text message or WhatsApp to your numbers. Unknown senders, unclear lines, a different price and a new address wait for you.'};
}
// Job 83's one review reads its order page requests and its text orders.
async function withPageRequests(db,ctx,options,pageReader){
  const [pages,messages]=await Promise.all([pageReader(db,ctx,options),readPage(db,ctx,options)]);
  return {summary:pages.summary+' '+messages.summary,rows:pages.rows.concat(messages.rows),more:Boolean(pages.more||messages.more)};
}

module.exports={JOB,kind,path,publicPath,CHANNELS,readText,customersFor,review,taught,create,handle,reply,process,receive,saveLine,saveRule,retry,dismiss,prepare,page,readPage,withPageRequests,
  actions:{created:CREATED,prepared:PREPARED}};
