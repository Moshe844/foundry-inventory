'use strict';
// Job 69: checks the ship-to address before any label is bought, on every
// plan. A label is held when the address is incomplete, differs from the
// order, is flagged by the carrier as undeliverable or unconfirmed, is a home
// address for a business customer, or is a PO box for a carrier that refuses
// them. The carrier's suggested correction is shown; a person accepts it
// unless it only changes formatting, which StockChief applies on its own.
const crypto=require('node:crypto');
const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');
const audit=require('../operations/postgres-security-audit');
const addresses=require('./address');
const validation=require('./address-validation');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const JOB=69,CAPABILITY='shipping.address_check',table='stockchief_runtime.agent_address_checks';
const shipping=()=>require('./postgres-service');
const installed=db=>require('../db/schema-installed').has(db,table);
const LABEL_BUSY=['PURCHASED','PENDING','REVIEW','VOID_PENDING'];

// Return parcels go to the business itself; customer-direct parcels are the
// supplier's. Neither is addressed by this check.
function outside(view){return Boolean(view.shipment.customer_return_id)||view.shipment.delivery_kind==='CUSTOMER_DIRECT';}
function plain(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function keyOf(parsed){return parsed?.complete?validation.key(parsed):'raw:'+plain(parsed?.raw);}

async function orderFacts(db,workspaceId,orderId){
  return (await db.query(`SELECT o.ship_to_address,c.company,c.name AS customer FROM sales_orders o
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id WHERE o.workspace_id=$1 AND o.id=$2`,[workspaceId,orderId])).rows[0]||{};
}

// The exact situation being judged: the parcel's address, the order's address
// and whether the customer is a business. Formatting alone never changes it.
function describe(view,facts){
  const order=addresses.parse(facts.ship_to_address),business=String(facts.company||'').trim();
  const parcelKey=keyOf(view.to),orderKey=keyOf(order);
  return {to:view.to,text:view.shipment.ship_to_address||'',orderText:facts.ship_to_address||null,business,
    changed:parcelKey!==orderKey,poBox:validation.poBox(view.to),
    fingerprint:crypto.createHash('sha256').update(JSON.stringify([parcelKey,orderKey,Boolean(business)])).digest('hex')};
}

async function current(db,workspaceId,shipmentId,fingerprint,lock=false){
  return (await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND shipment_id=$2 AND fingerprint=$3${lock?' FOR UPDATE':''}`,
    [workspaceId,shipmentId,fingerprint])).rows[0]||null;
}

// Which address check, if any, belongs to each connected account. A caller
// that supplies its own carrier adapter only gets the check that adapter
// itself offers, so tests and sandboxes never make a hidden carrier call.
function validatorFor(account,options){
  if(options.provider)return typeof options.provider.validateAddress==='function'?options.provider.validateAddress.bind(options.provider):null;
  if(options.providerResolver){const p=options.providerResolver(account.provider);return typeof p?.validateAddress==='function'?p.validateAddress.bind(p):null;}
  return validation.forProvider(account.provider);
}

function judge(subject,answer){
  const problems=[];let result='UNCHECKED',suggested=null;
  if(answer?.failed){result='FAILED';problems.push(['failed','The carrier could not check this address just now.']);}
  else if(answer){
    const matched=answer.matched;
    if(answer.status==='UNDELIVERABLE'){result='UNDELIVERABLE';if(matched&&!validation.sameAddress(matched,subject.to))suggested=validation.oneLine(matched);
      problems.push(['undeliverable','The carrier says it cannot deliver to this address.']);}
    else if(answer.status!=='VERIFIED'||!matched){result='UNVERIFIED';problems.push(['unverified','The carrier could not confirm this address.']);}
    else if(validation.sameAddress(matched,subject.to)){
      const formatted=validation.oneLine(matched);
      result=plain(formatted)===plain(addresses.oneLine(subject.to))?'VERIFIED':'FORMATTED';if(result==='FORMATTED')suggested=formatted;
    }else{result='CORRECTED';suggested=validation.oneLine(matched);problems.push(['correction','The carrier suggests a corrected address: '+suggested+'.']);}
    if(answer.residential===true&&subject.business)
      problems.push(['residential','The carrier says this is a home address, but the customer is the business '+subject.business+'.']);
  }
  if(subject.changed)problems.unshift(['changed',subject.orderText?'This parcel is addressed differently from the order ('+subject.orderText+').':'The order has no delivery address of its own.']);
  const hold=problems[0]?.[0]||null;
  return {result,suggested:suggested||(hold==='changed'&&subject.orderText&&addresses.parse(subject.orderText).complete?subject.orderText:null),
    hold,holdReason:hold?problems.map(p=>p[1]).join(' '):null,messages:answer?.messages||[]};
}

// May StockChief apply a formatting-only correction itself right now?
async function mayFormat(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return false;
  return !await policy.stopped(db,workspaceId,account,CAPABILITY,true);
}

// Runs before rates are fetched. Reuses an earlier answer for the same exact
// situation; a failed carrier check is tried again next time.
async function check(database,ctx,shipmentId,options={}){
  if(!await installed(database))return null;
  const view=await shipping().state(database,ctx.workspaceId,shipmentId);
  if(outside(view)||!view.to.complete||LABEL_BUSY.includes(view.shipment.label_status)||!['PICKING','PACKED'].includes(view.shipment.status))return null;
  const subject=describe(view,await orderFacts(database,ctx.workspaceId,view.shipment.sales_order_id));
  const prior=await current(database,ctx.workspaceId,shipmentId,subject.fingerprint);
  const candidates=view.shippingAccounts.map(account=>({account,validate:validatorFor(account,options)})).filter(c=>c.validate);
  if(prior&&prior.result!=='FAILED'&&!(prior.result==='UNCHECKED'&&candidates.length))return prior;
  let answer=null,used=null;
  if(candidates.length&&!subject.changed){
    used=candidates[0];
    const keyField=require('./postgres-accounts').KEY_FIELD[used.account.provider];
    try{
      answer=await require('../commercial/operations').run(database,ctx.workspaceId,{capability:'shipping.rates',key:'address-check:'+shipmentId+':'+subject.fingerprint+':'+newId('try'),
        provider:used.account.provider,operation:'address_lookup'},()=>used.validate({...ctx,...(keyField?{[keyField]:used.account.apiKey}:{})},subject.to));
    }catch(error){
      if(error?.code==='entitlement_required')throw error;
      const message=String(error?.message||'').replaceAll(used.account.apiKey,'[redacted]').slice(0,300);
      answer={failed:true,messages:message?[message]:[]};
    }
  }
  const verdict=judge(subject,answer);
  const row=await database.transaction(async client=>{
    const shipment=await shipping().requireShipment(client,ctx.workspaceId,shipmentId,true);
    if(shipment.ship_to_address!==view.shipment.ship_to_address)throw new ValidationError('The delivery address changed while it was being checked. Fetch rates again.');
    const at=nowIso();
    const saved=(await client.query(`INSERT INTO ${table}(id,workspace_id,shipment_id,fingerprint,address,order_address,provider,connector_id,result,residential,po_box,
        suggested_address,messages,hold,hold_reason,checked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)
      ON CONFLICT(workspace_id,shipment_id,fingerprint) DO UPDATE SET provider=EXCLUDED.provider,connector_id=EXCLUDED.connector_id,result=EXCLUDED.result,
        residential=EXCLUDED.residential,suggested_address=EXCLUDED.suggested_address,messages=EXCLUDED.messages,
        hold=CASE WHEN ${table}.decision IS NULL THEN EXCLUDED.hold ELSE ${table}.hold END,
        hold_reason=CASE WHEN ${table}.decision IS NULL THEN EXCLUDED.hold_reason ELSE ${table}.hold_reason END,checked_at=EXCLUDED.checked_at
      RETURNING *`,[newId('addrcheck'),ctx.workspaceId,shipmentId,subject.fingerprint,subject.text,subject.orderText,used?.account.provider||null,
      used?.account.connectorId||null,verdict.result,answer?.residential??null,subject.poBox,verdict.suggested,JSON.stringify(verdict.messages),verdict.hold,verdict.holdReason,at])).rows[0];
    if(saved.hold&&!saved.decision&&(!prior||prior.hold_reason!==saved.hold_reason))
      await audit.record(client,ctx,{action:'Held a label for an address check',reference:shipment.shipment_number,before:{address:subject.text},after:{hold:saved.hold,reason:saved.hold_reason,suggested:saved.suggested_address}});
    // A formatting-only answer is applied to the parcel without asking.
    if(saved.result==='FORMATTED'&&!saved.hold&&!saved.decision&&!shipment.ship_to_address_fields&&await mayFormat(client,ctx.workspaceId)){
      const formatted=saved.suggested_address;
      await client.query('UPDATE sales_shipments SET ship_to_address=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,shipmentId,formatted,at]);
      await client.query(`UPDATE ${table} SET decision='FORMATTED',decided_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,saved.id,at]);
      await audit.record(client,ctx,{action:'Applied the carrier’s address formatting',reference:shipment.shipment_number,before:{address:subject.text},after:{address:formatted}});
      return {...saved,decision:'FORMATTED',decided_at:at};
    }
    return saved;
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return row;
}

// The gate on every label purchase, by a person or by the agent.
async function assertClear(db,workspaceId,view,rate=null){
  if(outside(view))return;
  if(!view.to.complete)throw Object.assign(new ValidationError(addresses.why(view.to)),{code:'address_hold'});
  if(rate&&validation.poBox(view.to)&&validation.refusesPoBox(rate))
    throw Object.assign(new ValidationError(require('../sales/carriers').displayName(rate.carrier)+' does not deliver to PO boxes. Choose a postal service for this parcel.'),{code:'address_hold'});
  if(!await installed(db))return;
  const subject=describe(view,await orderFacts(db,workspaceId,view.shipment.sales_order_id));
  const row=await current(db,workspaceId,view.shipment.id,subject.fingerprint);
  if(!row)throw Object.assign(new ValidationError('Fetch rates again so StockChief can check this address before buying a label.'),{code:'address_hold'});
  if(row.hold&&!['KEPT','ACCEPTED'].includes(row.decision))
    throw Object.assign(new ValidationError(row.hold_reason+' Confirm the address on the order before buying a label.'),{code:'address_hold'});
}

// What the order's Ship panel and the shipment page show.
async function view(db,workspaceId,shipmentId){
  if(!await installed(db))return null;
  const state=await shipping().state(db,workspaceId,shipmentId);
  if(outside(state)||!state.to.complete)return null;
  const subject=describe(state,await orderFacts(db,workspaceId,state.shipment.sales_order_id));
  const row=await current(db,workspaceId,shipmentId,subject.fingerprint);
  if(!row)return {checked:false,poBox:subject.poBox};
  return {checked:true,id:row.id,result:row.result,held:Boolean(row.hold)&&!row.decision,hold:row.hold,reason:row.hold_reason,suggested:row.suggested_address,
    decision:row.decision,poBox:subject.poBox,canAccept:Boolean(row.suggested_address)&&row.hold!=='residential'&&!state.shipment.ship_to_address_fields,
    messages:row.messages||[]};
}

// A person accepts the suggested address or ships to the address as it is.
async function decide(database,ctx,shipmentId,input={}){
  if(!['accept','keep'].includes(input.action))throw new ValidationError('Choose whether to use the suggested address or keep this one.');
  return database.transaction(async client=>{
    const user=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    permissions.assertCan(user,permissions.OPERATE,'confirm a delivery address');
    const shipment=await shipping().requireShipment(client,ctx.workspaceId,shipmentId,true);
    shipping().assertParcelEditable(shipment);
    const view=await shipping().state(client,ctx.workspaceId,shipmentId);
    const subject=describe(view,await orderFacts(client,ctx.workspaceId,shipment.sales_order_id));
    const row=await current(client,ctx.workspaceId,shipmentId,subject.fingerprint,true);
    if(!row||row.id!==input.checkId||!row.hold||row.decision)throw new ValidationError('This address check changed. Open the order again to see the current address.');
    const at=nowIso();
    if(input.action==='keep'){
      await client.query(`UPDATE ${table} SET decision='KEPT',decided_by=$3,decided_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId,at]);
      await audit.record(client,ctx,{action:'Confirmed a delivery address after a check',reference:shipment.shipment_number,before:{hold:row.hold,reason:row.hold_reason},after:{address:row.address,decision:'KEPT'}});
      return {decision:'KEPT',addressChanged:false};
    }
    if(!row.suggested_address||row.hold==='residential')throw new ValidationError('There is no suggested address to use. Change the address on the order instead.');
    if(shipment.ship_to_address_fields)throw new ValidationError('Change this international address on the order.');
    const parsed=addresses.parse(row.suggested_address);
    if(!parsed.complete)throw new ValidationError(addresses.why(parsed));
    await client.query('UPDATE sales_shipments SET ship_to_address=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,shipmentId,row.suggested_address,at]);
    // A carrier correction applies to the order too, so the two stay the same.
    if(row.hold!=='changed')await client.query("UPDATE sales_orders SET ship_to_address=$3,ship_to_source='order',updated_at=$4 WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId,shipment.sales_order_id,row.suggested_address,at]);
    await client.query(`UPDATE ${table} SET decision='ACCEPTED',decided_by=$3,decided_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId,at]);
    await audit.record(client,ctx,{action:'Used the suggested delivery address',reference:shipment.shipment_number,before:{address:row.address},after:{address:row.suggested_address,decision:'ACCEPTED'}});
    return {decision:'ACCEPTED',addressChanged:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Needs you: parcels whose label is waiting on an address answer.
async function inbox(db,workspaceId){
  const {rows}=await db.query(`SELECT DISTINCT ON (a.shipment_id) a.id,a.hold_reason,a.checked_at,s.shipment_number,s.sales_order_id,o.order_number
    FROM ${table} a JOIN sales_shipments s ON s.workspace_id=a.workspace_id AND s.id=a.shipment_id
    JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE a.workspace_id=$1 AND a.hold IS NOT NULL AND a.decision IS NULL AND s.status IN ('PICKING','PACKED') AND o.status<>'CANCELLED'
      AND coalesce(s.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING') AND s.ship_to_address=a.address
    ORDER BY a.shipment_id,a.checked_at DESC LIMIT 25`,[workspaceId]);
  return rows.map(r=>({kind:'shipping',importance:'Needs You',priority:72,title:'Check the delivery address for order '+r.order_number,
    happened:r.hold_reason,why:'StockChief will not buy a label for an address that may not arrive.',
    recommendation:'Use the suggested address, keep this one, or correct it on the order.',href:'/orders/'+r.sales_order_id+'#ship-now',
    actionLabel:'Check the address',sourceId:'address-check:'+r.id,at:r.checked_at,createdAt:r.checked_at}));
}

module.exports={check,assertClear,view,decide,inbox,describe,judge,CAPABILITY};
