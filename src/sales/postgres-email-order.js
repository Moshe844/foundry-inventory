'use strict';
// Job 52: a customer's email, or the PDF or spreadsheet attached to it, becomes
// a sales order. Growth prepares the draft for approval. Pro and Custom create
// and confirm it on their own when every fact matches: a known customer by
// sender, exact products (our code, the customer's own code or a barcode),
// quantities, a delivery address already on file and prices that match the
// customer's prices. Anything new or unclear stops and asks.

const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');
const {ValidationError,NotFoundError}=require('../domain/errors');
const promotions=require('../pricing/postgres-promotions');
const money=require('../domain/currency');
const orders=require('./agent-customer-orders');
const {has}=require('../db/schema-installed');
const uncertain=detail=>new ValidationError(detail||'Review the original message. StockChief needs an exact product code and quantity for every line, and clear delivery instructions.');
const orderSubject=/^(?:(?:new |customer |purchase |sales )?order|purchase order attached|order request|po)(?:\s*(?:[:#-]|no\.|number)\s*[\w.-]+)?[.!]?$/i;
const orderReference=/^(?:purchase order|customer po|po)\s*(?:#|no\.?|number|:)\s*([\w.-]{1,60})$/i;
const expected=error=>[400,402,403,404,409,422].includes(error?.status);

function isOrderEnvelope(subject,body,hasAttachments){
  if(!orderSubject.test(String(subject||'').trim()))return false;
  return Boolean(hasAttachments||String(body||'').split(/\r?\n/).some(line=>orderReference.test(line.trim())));
}

// A stated price may follow a line: "@ 7.50", "at $7.50 each", "price 7.50".
const PRICE=String.raw`(?:\s*(?:@|at|price:?)\s*(?<price>(?:[A-Z]{3}\s?|[$€£])?\d+(?:[.,]\d{1,4})?)(?:\s*(?:each|ea\.?|per unit|/\s*(?:unit|ea)))?)?`;
const codeFirst=new RegExp(String.raw`^(?:SKU\s+)?(?<code>[\w./-]+)\s+(?:qty\.?\s*[:=]?\s*|[x×]\s*)(?<qty>\d+(?:\.\d+)?)(?:\s*(?:units?|pcs|pieces))?`+PRICE+String.raw`[.]?$`,'i');
const quantityFirst=new RegExp(String.raw`^(?:please order\s+)?(?<qty>\d+(?:\.\d+)?)\s*(?:[x×]\s*|units?\s+of\s+|pcs\s+of\s+)(?<code>[\w./-]+?)`+PRICE+String.raw`[.]?$`,'i');
// PDF text can put several printed rows on one line.
const tableRow=/(?:^|[ \t])((?:SKU[ \t]+)?[\w./-]+[ \t]+(?:qty\.?[ \t]*[:=]?[ \t]*|[x×][ \t]*)\d+(?:\.\d+)?)(?=[ \t\r\n]|$)/gim;
const shipToLine=/^(?:ship(?:ping)?[\s-]+to|deliver(?:y)?\s+to|delivery\s+address|shipping\s+address)\s*[:-]?\s*(.*)$/i;
const greeting=/^(?:hello|hi|hey|dear|good (?:morning|afternoon|evening))(?:\s+[\p{L}.'-]+){0,3}[!.,]*$/iu;
// A sign-off ends the message; the name under it is not part of the order.
const signOff=/^(?:thanks|thank you|many thanks|regards|best|best regards|kind regards|warm regards|cheers|sincerely)(?:\s+(?:again|so much|a lot))?(?:[!.,]+(?:\s*[\p{L}.'-]+){0,3})?[!.,]*$/iu;
const orderIntro=/^(?:purchase order|new order|please (?:see|find) (?:the )?(?:attached|below|enclosed)(?: (?:purchase )?order)?|please order(?: the following)?|(?:here is|attached is) (?:our|my|the) (?:purchase )?order|we would like to order(?: the following)?)[.!:]?$/i;
const quoted=/^(?:>|on .{0,120}wrote:|-{2,}\s*original message|from:\s)/i;
// Spreadsheet and table columns.
const delimiters=['|','\t',';',','];
const codeHeader=/^(?:sku|code|item|item\s*(?:code|no\.?|number|#)|product\s*code|part|part\s*(?:no\.?|number|#)|barcode|upc|ean|gtin|your\s+code|customer\s+code|our\s+code)$/i;
const qtyHeader=/^(?:qty\.?|quantity|units|order\s*qty|qty\s*ordered|ordered|quantity\s+ordered)$/i;
const priceHeader=/^(?:price|unit\s*price|price\s*each|each|unit\s*cost|rate|net\s*price)$/i;
const keys=[[/^(?:purchase order|customer po|po)(?:\s*(?:#|no\.?|number))?$/i,'reference'],
  [/^(?:ship(?:ping)?[\s-]+to|deliver(?:y)?\s+to|delivery address|shipping address)$/i,'shipTo'],
  [/^(?:order\s+)?date$/i,'date'],[/^(?:customer|company|account|buyer)$/i,'customer']];
const cells=(line,d)=>line.split(d).map(s=>s.trim());
const norm=value=>String(value||'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

function header(line){
  for(const d of delimiters){
    if(!line.includes(d))continue;
    const row=cells(line,d),code=row.findIndex(c=>codeHeader.test(c)),qty=row.findIndex(c=>qtyHeader.test(c));
    if(code>=0&&qty>=0)return {d,code,qty,price:row.findIndex(c=>priceHeader.test(c))};
  }
  return null;
}
function keyValue(line){
  for(const d of delimiters){
    if(!line.includes(d))continue;
    const row=cells(line,d).filter(Boolean);if(row.length!==2)continue;
    const key=keys.find(([pattern])=>pattern.test(row[0].replace(/[:#]\s*$/,'').trim()));
    if(key)return {key:key[1],value:row[1]};
  }
  return null;
}

// Every line must be part of the order. A date, a note or a second instruction
// must never silently become a quantity or disappear from the order.
// intro: another opening line that starts the list, such as a quote request (job 73).
function parse(parts,{intro=null}={}){
  if(parts.join('\n').length>30000)throw uncertain();
  const out={reference:null,lines:[],pickup:false,shipTo:null,names:[]},codes=new Set();let ordered=false;
  const reference=value=>{
    if(!/^[\w.-]{1,60}$/.test(value))throw uncertain('Review the purchase order number “'+value.slice(0,60)+'”.');
    if(out.reference&&out.reference.toLowerCase()!==value.toLowerCase())throw uncertain('The order names two purchase order numbers. Review the original.');
    out.reference=value;ordered=true;
  };
  const shipTo=value=>{
    if(out.shipTo&&norm(out.shipTo)!==norm(value))throw uncertain('The order names two delivery addresses. Review the original.');
    out.shipTo=value;
  };
  const add=(code,qty,price,raw)=>{
    code=String(code||'').trim().replace(/\.$/,'');const quantity=Number(qty);
    if(!/^[\w./-]{1,80}$/.test(code)||!(quantity>0)||quantity>100000000||out.lines.length>=100)
      throw uncertain('Review the line “'+String(raw).slice(0,120)+'”. StockChief needs one product code and a positive quantity.');
    const key=code.toLowerCase();
    if(codes.has(key))throw uncertain('The code '+code+' appears twice. Review the original and enter the order yourself.');
    codes.add(key);out.lines.push({code,quantity,price:price?String(price).trim():null});
  };
  for(const text of parts){
    let table=null,address=null,ended=false;
    const close=()=>{if(address){if(address.length)shipTo(address.join(', '));else throw uncertain('The delivery address is empty. Review the original.');address=null;}};
    const lines=String(text||'').split(/\r?\n/).flatMap(line=>/[|\t]/.test(line)?[line]:line.replace(tableRow,'\n$1').split('\n'));
    for(const raw of lines){
      const line=raw.trim();
      if(ended)break;
      if(!line||/^[|,;\s]*$/.test(line)){close();continue;}
      if(quoted.test(line)||signOff.test(line)){close();ended=true;continue;}
      if(table&&header(line))continue;
      if(table){
        if(line.includes(table.d)){
          const row=cells(line,table.d);
          if(row.length>Math.max(table.code,table.qty)){
            const first=row.find(Boolean)||'';
            if(/^(?:sub\s*)?total\b|^grand\s+total\b/i.test(first))continue;
            const code=row[table.code],qty=row[table.qty];
            if(!code&&!qty)throw uncertain('Review the row “'+line.slice(0,120)+'”. It has no product code or quantity.');
            if(!code||!/^\d+(?:\.\d+)?$/.test(qty))throw uncertain('Review the row “'+line.slice(0,120)+'”. StockChief needs one product code and a quantity.');
            add(code,qty,table.price>=0?row[table.price]:null,line);continue;
          }
        }
        table=null;
      }
      const found=header(line);
      if(found){close();table=found;ordered=true;continue;}
      const pair=/[|\t]/.test(line)||/^[^,;]+[,;][^,;]+$/.test(line)?keyValue(line):null;
      if(pair){
        close();
        if(pair.key==='reference')reference(pair.value);
        else if(pair.key==='shipTo')shipTo(pair.value);
        else if(pair.key==='customer')out.names.push(pair.value);
        continue;
      }
      if(/^sheet:\s/i.test(line)||greeting.test(line))continue;
      if(orderIntro.test(line)||intro?.test(line)){close();ordered=true;continue;}
      const po=orderReference.exec(line);
      if(po){close();reference(po[1]);continue;}
      if(/^(?:customer pickup|pickup|pick up|we will collect)[.!]?$/i.test(line)){close();out.pickup=true;continue;}
      const ship=shipToLine.exec(line);
      if(ship){close();address=ship[1].trim()?[ship[1].trim()]:[];continue;}
      // "3 x 0123456789012" reads both ways when a code is all digits: keep
      // only a reading with a plausible quantity, or ask.
      const readings=[codeFirst.exec(line),quantityFirst.exec(line)].filter(Boolean);
      const plausible=readings.filter(m=>!/^0\d/.test(m.groups.qty)&&Number(m.groups.qty)<=100000);
      if(readings.length>1&&plausible.length!==1)throw uncertain('“'+line.slice(0,120)+'” can be read two ways. Review the original and enter the order yourself.');
      const item=readings.length>1?plausible[0]:readings[0];
      if(item){close();if(/^please order\s/i.test(line))ordered=true;add(item.groups.code,item.groups.qty,item.groups.price,line);continue;}
      if(address){address.push(line);continue;}
      throw uncertain('StockChief could not read “'+line.slice(0,120)+'” as part of the order. Review the original and enter the order yourself.');
    }
    close();
  }
  if(out.pickup&&out.shipTo)throw uncertain('The order asks for both pickup and delivery. Review the original.');
  if(!ordered||!out.lines.length)throw uncertain();
  return out;
}

// Addresses already on file for this customer: their profile and the
// addresses their earlier orders went to.
async function addressesOnFile(c,workspaceId,customer){
  const used=(await c.query(`SELECT DISTINCT ship_to_address FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND delivery_method='SHIP'
    AND ship_to_address IS NOT NULL AND status<>'CANCELLED' LIMIT 200`,[workspaceId,customer.id])).rows.map(r=>r.ship_to_address);
  return [customer.shipping_address,...used].filter(Boolean);
}

async function review(c,ctx,id,{lock=false}={}){
  await policy.requireWorkspaceJob(c,ctx.workspaceId,52,'draft');
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(c,ctx.workspaceId);
  await require('../commercial/entitlements').assertCapability(c,scope,'sales_orders.core');
  const actor=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.OPERATE,'prepare a customer order');
  const m=(await c.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
  if(!m)throw new NotFoundError('This email was not found.');
  const existing=(await c.query('SELECT id,order_number FROM sales_orders WHERE workspace_id=$1 AND source_email_message_id=$2',[ctx.workspaceId,id])).rows[0];
  if(existing)return {existing};
  if(m.trust_status!=='TRUSTED'||m.classification!=='customer'||m.supplier_id)throw uncertain('This email is not from a known customer. Review it and enter the order yourself.');
  if(!orderSubject.test(String(m.subject||'').trim()))
    throw new ValidationError('Review the subject and original email before preparing this order.');
  const customers=(await c.query(`SELECT id,name,company,shipping_address FROM customers WHERE workspace_id=$1 AND lower(email)=lower($2) AND record_state='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='active') LIMIT 2`,[ctx.workspaceId,m.sender])).rows;
  if(customers.length!==1)throw uncertain('The sender is not exactly one of your customers. Review the email and enter the order yourself.');
  const customer=customers[0];
  const documents=(await c.query('SELECT filename,content_hash,extraction_status,extracted_text FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id',[ctx.workspaceId,id])).rows;
  if(documents.some(d=>d.extraction_status!=='READABLE'||!d.extracted_text))throw new ValidationError('Wait for every attachment to finish reading, or review the original document.');
  const parsed=parse([m.body_text||'',...documents.map(d=>d.extracted_text)]);
  const subjectRef=/\s*(?:[:#]|no\.|number)\s*([\w.-]+)$/i.exec(m.subject||'');
  if(subjectRef&&parsed.reference&&subjectRef[1].toLowerCase()!==parsed.reference.toLowerCase())throw uncertain('The subject and the order name different purchase order numbers.');
  if(!parsed.reference&&subjectRef)parsed.reference=subjectRef[1];
  for(const name of parsed.names)if(![customer.name,customer.company].filter(Boolean).some(n=>norm(n)===norm(name)))
    throw uncertain('The order names the customer “'+name.slice(0,80)+'”, not '+customer.name+'. Review the original.');
  let address=null,newAddress=false;
  if(!parsed.pickup){
    if(parsed.shipTo){
      const known=(await addressesOnFile(c,ctx.workspaceId,customer)).find(a=>norm(a)===norm(parsed.shipTo));
      address=known||parsed.shipTo;newAddress=!known;
    }else if(customer.shipping_address)address=customer.shipping_address;
    else throw new ValidationError('Add a delivery address to this customer before creating the order.');
  }
  const found=await orders.identify(c,ctx.workspaceId,customer.id,parsed.lines.map(l=>l.code));
  const lines=parsed.lines.map(line=>({skuId:found.get(line.code.toLowerCase()).id,quantity:line.quantity}));
  if(new Set(lines.map(l=>l.skuId)).size!==lines.length)throw uncertain('The order lists the same product twice under different codes. Review the original and enter the order yourself.');
  const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  const input={customerId:customer.id,reference:parsed.reference,currency,deliveryMethod:parsed.pickup?'PICKUP':'SHIP',
    ...(parsed.shipTo&&address?{shipToAddress:address}:{}),lines,idempotencyKey:'customer-order-email:'+id};
  const quote=await promotions.prepareQuote(c,ctx,input,{lock});
  await require('./agent-customer-pricing').checkOrder(c,ctx,input,quote);
  if(quote.violations.length)throw new ValidationError('Review the current selling prices and pricing safeguards before creating this order.');
  const problems=[];
  for(const [index,line] of parsed.lines.entries()){
    if(!line.price)continue;
    const priced=quote.lines[index],sku=found.get(line.code.toLowerCase());
    let stated;
    try{stated=money.userToMinor(line.price.replace(/^(\d+),(\d{1,2})$/,'$1.$2'),currency);}
    catch{problems.push(sku.code+': StockChief could not read the price “'+line.price+'” in '+currency+'.');continue;}
    const net=Number(priced.netMinor),quantity=Number(priced.quantity);
    if(stated!==Number(priced.unitPriceMinor)&&Math.round(stated*quantity)!==net)
      problems.push(sku.code+': the customer wrote '+money.format(stated,currency)+'; your price is '+money.format(Number(priced.unitPriceMinor),currency)+'.');
  }
  if(newAddress)problems.push('New delivery address: '+address+'. A person checks new addresses.');
  input.pricingQuoteHash=promotions.quoteHash(quote);
  const digest=promotions.hash({input,address,sender:m.sender,body:m.body_text,documents:documents.map(d=>d.content_hash)});
  const skus=[...found.values()];
  return {input,digest,customer,quote,skus,problems,address,newAddress,message:m};
}

async function record(c,workspaceId,id,fields){
  if(!await has(c,'stockchief_runtime.agent_customer_email_orders'))return;
  await c.query(`INSERT INTO stockchief_runtime.agent_customer_email_orders(workspace_id,message_id,customer_id,status,reason,sales_order_id,automatic,total_minor,currency)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,message_id) DO UPDATE SET customer_id=coalesce(EXCLUDED.customer_id,agent_customer_email_orders.customer_id),
      status=EXCLUDED.status,reason=EXCLUDED.reason,sales_order_id=coalesce(EXCLUDED.sales_order_id,agent_customer_email_orders.sales_order_id),
      automatic=EXCLUDED.automatic,total_minor=coalesce(EXCLUDED.total_minor,agent_customer_email_orders.total_minor),
      currency=coalesce(EXCLUDED.currency,agent_customer_email_orders.currency),updated_at=clock_timestamp()
    WHERE agent_customer_email_orders.sales_order_id IS NULL OR EXCLUDED.sales_order_id IS NOT NULL`,
  [workspaceId,id,fields.customerId||null,fields.status,fields.reason||null,fields.salesOrderId||null,Boolean(fields.automatic),fields.totalMinor??null,fields.currency||null]);
}

// A person creates the draft from the review form (digest), or StockChief does
// it for the agent (agent:true). With the owner's routine authority and every
// fact matching, StockChief also confirms the order through the ordinary path.
async function create(db,ctx,id,digest,{agent=false}={}){
  return db.transaction(async c=>{
    const decision=agent?await orders.decide(c,ctx.workspaceId,52):null;
    if(agent&&decision.mode==='skip')throw new ValidationError('Customer orders from email need the Growth plan or above.');
    if(agent&&decision.mode==='watch')throw Object.assign(new ValidationError(decision.reason),{watch:true});
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,52,'draft');
    if(!agent){
      const stop=await policy.stopped(c,ctx.workspaceId,state,'sales_order.create',false,{})||
        await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,52,false);
      if(stop)throw new ValidationError(stop);
    }
    const result=await review(c,ctx,id,{lock:true});
    if(result.existing)return {salesOrderId:result.existing.id,orderNumber:result.existing.order_number,replayed:true};
    if(!agent&&result.digest!==digest)throw new ValidationError('The order details changed. Review the current order before saving.');
    if(agent&&result.problems.length)throw new ValidationError(result.problems.join(' '));
    const {input,quote}=result;
    let gate=null;
    if(agent){
      gate=decision.mode!=='automatic'?decision.reason:
        !input.reference?'The customer did not give a purchase order number, so a person checks this order.':
        await orders.needsPerson(c,ctx.workspaceId,input.customerId,{pickup:input.deliveryMethod==='PICKUP',address:result.address})||
        orders.overLimit(decision.limit,{currency:input.currency,totalMinor:quote.totalMinor,units:orders.units(input.lines)});
    }
    if(input.reference){
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,input.customerId,input.reference.toLowerCase()])]);
      if((await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,input.customerId,input.reference])).rowCount)
        throw new ValidationError('An order already uses this customer purchase order number. Check it before creating another.');
    }
    const created=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,input);
    await c.query('UPDATE sales_orders SET source_email_message_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,created.salesOrderId,id]);
    await c.query('UPDATE connection_email_messages SET order_draft_reason=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
    const automatic=agent&&!gate;
    const confirmed=automatic?await orders.confirm(c,ctx,created.salesOrderId,'customer-order-email-confirm:'+id):null;
    const status=confirmed&&!confirmed.held?'CONFIRMED':'DRAFTED';
    const reason=confirmed?.held?'StockChief created this order but did not confirm it. '+confirmed.held:gate;
    await record(c,ctx.workspaceId,id,{customerId:input.customerId,status,reason,salesOrderId:created.salesOrderId,automatic,totalMinor:quote.totalMinor,currency:input.currency});
    await require('../operations/postgres-security-audit').record(c,ctx,{action:status==='CONFIRMED'?'Customer order from email created and confirmed by StockChief':
      agent?'Customer order from email prepared by StockChief for approval':'Customer order from email drafted',reference:created.orderNumber,
      after:{messageId:id,customerId:input.customerId,reference:input.reference||null,totalMinor:quote.totalMinor,currency:input.currency,
        lines:input.lines,deliveryMethod:input.deliveryMethod,address:result.address,status:confirmed?.status||'DRAFT',reason:reason||null}});
    return {...created,status:confirmed?.status||'DRAFT',automatic,...(reason?{reason}:{})};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function hold(db,workspaceId,id,status,reason){
  const m=(await db.query('SELECT sender FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  const customer=m?(await db.query("SELECT id FROM customers WHERE workspace_id=$1 AND lower(email)=lower($2) AND record_state='ACTIVE' LIMIT 2",[workspaceId,m.sender])).rows:[];
  await db.transaction(async c=>{
    await c.query(`UPDATE connection_email_messages m SET order_draft_reason=$3 WHERE workspace_id=$1 AND id=$2
      AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=m.workspace_id AND o.source_email_message_id=m.id)`,[workspaceId,id,reason]);
    if(!(await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND source_email_message_id=$2',[workspaceId,id])).rowCount)
      await record(c,workspaceId,id,{customerId:customer.length===1?customer[0].id:null,status,reason});
  });
}

async function onArrival(db,workspaceId,id){
  const m=(await db.query(`SELECT m.subject,m.body_text,m.agent_category,m.classification,m.trust_status,EXISTS(
    SELECT 1 FROM connection_email_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id) AS has_attachments
    FROM connection_email_messages m WHERE m.workspace_id=$1 AND m.id=$2`,[workspaceId,id])).rows[0];
  if(!m||m.classification!=='customer'||m.trust_status!=='TRUSTED')return {skipped:true};
  if(m.agent_category!=='order'&&!isOrderEnvelope(m.subject,m.body_text,m.has_attachments))return {skipped:true};
  // "Same as last month" is job 53's repeat order, not a list of lines.
  if(!m.has_attachments&&require('./agent-repeat-orders').isEmailRequest(m.subject,m.body_text))return {skipped:true};
  const decision=await orders.decide(db,workspaceId,52);
  if(decision.mode==='skip')return {skipped:true};
  const actorId=(decision.mode==='automatic'&&decision.actorId)||await orders.ownerUser(db,workspaceId);
  if(!actorId)return {skipped:true};
  const ctx={workspaceId,actorId};
  try{return await create(db,ctx,id,null,{agent:true});}
  catch(error){
    if(!expected(error))throw error;
    let reason=error.message;
    // Shadow, Watch only and pause: say what StockChief would have done.
    if(error.watch){
      try{
        const would=await db.transaction(c=>review(c,ctx,id));
        if(would.existing)return {replayed:true,salesOrderId:would.existing.id};
        reason+=would.problems.length?' It would have asked you: '+would.problems.join(' '):
          ' It would have prepared '+would.customer.name+'’s order for '+money.format(would.quote.totalMinor,would.input.currency)+'.';
      }catch(inner){if(!expected(inner))throw inner;reason+=' It would have asked you: '+inner.message;}
    }
    await hold(db,workspaceId,id,error.watch?'WATCHED':'HELD',reason);
    return {held:true,reason};
  }
}
module.exports={review,create,onArrival,isOrderEnvelope,parse,orderSubject};
