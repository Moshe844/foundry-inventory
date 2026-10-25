'use strict';
const service=require('./postgres-service'),P=require('../actions/permissions'),{ValidationError}=require('../domain/errors'),{newId}=require('../lib/util'),hash=require('../pricing/postgres-promotions').hash;
const sameClient=client=>({query:(sql,args)=>client.query(sql,args),transaction:work=>work(client)});
const contracts=[
 ['configure','configure','Configure production work-in-progress accounting','',P.MANAGE_ACCOUNTING,['wipAccountId']],
 ['create_work_centre','createWorkCentre','Create a work centre with recorded daily capacity','',P.ADMIN,['name','capacityMinutesPerDay']],
 ['create_bom','createBom','Prepare an immutable production BOM revision','',P.OPERATE,['outputSkuId','outputQuantity','leadTimeDays','components','routing']],
 ['approve_bom','activateBom','Approve one exact production BOM revision','manufacturing_bom',P.ADMIN,[]],
 ['create_work_order','createWorkOrder','Create a draft production work order','',P.OPERATE,['bomId','quantity','neededBy']],
 ['reserve_capacity','reserveCapacity','Reserve finite work-centre capacity on calendar dates','manufacturing_work_order',P.OPERATE,['confirmed','earliestStart']],
 ['start','start','Consume physically confirmed BOM components and start production','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','materials']],
 ['record_operation','recordOperation','Record actual progress at a production routing operation','manufacturing_work_order',P.OPERATE,['operation','quantity','actualMinutes']],
 ['complete','complete','Receive physically confirmed finished production and record scrap','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','good','scrap','locationId','lotId','lotCode','serials','expiresAt']],
 ['add_cost','addCost','Capitalize an evidenced posted production expense before output','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','amountMinor','sourceJournalLineId']],
 ['reverse_cost','reverseCost','Reverse an exact production expense allocation before output','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','costAdditionId']],
 ['recover_material','recoverMaterial','Receive confirmed unused components from an aborted work order at their original allocated cost; remaining production must then be cancelled','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','materialUseId','quantity','locationId','serialUnitIds']],
 ['cancel','cancel','Cancel remaining production and write off remaining work-in-progress value','manufacturing_work_order',P.MANAGE_ACCOUNTING,['confirmed','reason']],
];
function parse(raw,fields){let input;try{input=JSON.parse(raw||'{}');}catch{throw new ValidationError('Production details must match the discovered structured contract.');}if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!fields.includes(k)))throw new ValidationError('Use only the fields supported by this production operation.');return input;}
async function state(client,ctx,record,id){
 if(record==='manufacturing_work_order'){const job=await service.getWorkOrder(client,ctx.workspaceId,id,{lock:true}),events=(await client.query('SELECT id FROM manufacturing_events WHERE workspace_id=$1 AND work_order_id=$2 ORDER BY id',[ctx.workspaceId,id])).rows;return hash({job,events});}
 if(record==='manufacturing_bom'){const row=(await client.query('SELECT * FROM manufacturing_boms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!row)throw new ValidationError('Choose a BOM in this inventory.');return hash(row);}return null;
}
async function effect(client,ctx,result){
 const entries=[...(result.journalEntryIds||[]),result.journalEntryId].filter(Boolean),movements=[...(result.movements||[]),result.outputMovementId].filter(Boolean);
 const journals=entries.length?(await client.query('SELECT e.posting_date::text,l.account_id,l.currency,l.debit_minor,l.credit_minor FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id WHERE e.workspace_id=$1 AND e.id=ANY($2::text[]) ORDER BY e.posting_date,l.account_id,l.debit_minor,l.credit_minor',[ctx.workspaceId,entries])).rows:[];
 const stock=movements.length?(await client.query('SELECT m.sku_id,m.location_id,l.code lot_code,s.serial,quantity_delta,balance_after,operation FROM movements m LEFT JOIN lots l ON l.workspace_id=m.workspace_id AND l.id=m.lot_id LEFT JOIN serial_units s ON s.workspace_id=m.workspace_id AND s.id=m.serial_unit_id WHERE m.workspace_id=$1 AND m.id=ANY($2::text[]) ORDER BY m.sku_id,m.location_id,quantity_delta,balance_after,l.code,s.serial',[ctx.workspaceId,movements])).rows:[];
 const values=Object.fromEntries(Object.entries(result).filter(([k])=>!/(?:^id$|Id$|Ids$|^created_at$|^updated_at$|^created_by_user_id$|^approved_at$|^replayed$|^request_key$)/.test(k)&&!['created_at','started_at','completed_at'].includes(k)));
 // Generated record identifiers and wall-clock timestamps are not economic effects.
 delete values.events;delete values.movements;return {values,journals,stock};
}
async function invoke(client,ctx,method,id,input){return id?service[method](sameClient(client),ctx,id,input):service[method](sameClient(client),ctx,input);}
async function preview(db,ctx,method,record,id,input){return db.transaction(async client=>{
 await client.query('SAVEPOINT production_preview');try{const expectedState=await state(client,ctx,record,id),result=await invoke(client,ctx,method,id,input),effects=await effect(client,ctx,result);await client.query('ROLLBACK TO SAVEPOINT production_preview');await client.query('RELEASE SAVEPOINT production_preview');return {expectedState,effects,result};}catch(error){await client.query('ROLLBACK TO SAVEPOINT production_preview');await client.query('RELEASE SAVEPOINT production_preview');throw error;}
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function summary(db,ctx,description,input,result,record,row){
 const money=n=>require('../pricing/postgres-service').formatMinor(n,row?.currency||(result.currency||'USD'));let text=description+(row?.order_number?' for '+row.order_number:'')+'.';
 const label=async skuId=>{const p=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2',[ctx.workspaceId,skuId])).rows[0];if(!p)throw new ValidationError('A reviewed production product is no longer in this inventory.');return p.name+' ('+p.code+')';};
 if(input.wipAccountId){const account=(await db.query('SELECT code,name FROM accounting_accounts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.wipAccountId])).rows[0];text+=' Work-in-progress account: '+account.code+' · '+account.name+'.';}
 if(input.capacityMinutesPerDay!=null)text+=' Work centre: '+input.name+', '+input.capacityMinutesPerDay+' available minutes per calendar day.';
 if(record==='manufacturing_bom')text+=' BOM revision '+row.revision+' for '+await label(row.output_sku_id)+', '+row.definition.outputQuantity+' units per batch. Components: '+(await Promise.all(row.definition.components.map(async c=>c.quantity+' × '+await label(c.skuId)))).join('; ')+'.';
 if(record==='manufacturing_work_order'){const job=await service.getWorkOrder(db,ctx.workspaceId,row.id);text+=' Product: '+await label(job.output_sku_id)+'; BOM revision '+job.revision+'.';}
 if(input.bomId){const bom=(await db.query('SELECT * FROM manufacturing_boms WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.bomId])).rows[0];text+=' Product: '+await label(bom.output_sku_id)+'; approved BOM revision '+bom.revision+'.';}
 if(input.materials){for(const part of input.materials){const p=(await db.query('SELECT s.code,i.name,l.name location_name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$3 WHERE s.workspace_id=$1 AND s.id=$2',[ctx.workspaceId,part.skuId,part.locationId])).rows[0];text+=' '+part.quantity+' × '+p.name+' ('+p.code+') from '+p.location_name+'.';}}
 if(input.outputSkuId)text+=' Output: '+input.outputQuantity+' × '+await label(input.outputSkuId)+' per batch. Components: '+(await Promise.all(input.components.map(async c=>c.quantity+' × '+await label(c.skuId)))).join('; ')+'. Production lead time: '+(input.leadTimeDays||0)+' calendar days.';
 const routing=input.routing||(record==='manufacturing_bom'?row.definition.routing:null);if(routing?.length)for(const [index,step]of routing.entries()){const centre=step.workCentreId?(await db.query('SELECT name FROM manufacturing_work_centres WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,step.workCentreId])).rows[0]?.name:null;text+=' Operation '+(index+1)+': '+step.name+', '+(centre||'no assigned centre')+', '+(step.setupMinutes||0)+' setup minutes and '+(step.minutesPerBatch||0)+' minutes per batch.';}
 if(input.locationId){const location=(await db.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.locationId])).rows[0];text+=' Finished stock location: '+location.name+'.';}
 if(input.lotCode||input.lotId)text+=' Finished lot: '+(input.lotCode||(await db.query('SELECT code FROM lots WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.lotId])).rows[0]?.code)+'.';
 if(input.serials?.length)text+=' Finished serials: '+input.serials.join(', ')+'.';
 if(input.expiresAt)text+=' Finished lot expiry: '+input.expiresAt+'.';
 if(input.sourceJournalLineId){const source=(await db.query('SELECT e.entry_number,e.description,a.name FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.id=$2',[ctx.workspaceId,input.sourceJournalLineId])).rows[0];text+=' Evidenced expense: journal '+source.entry_number+', '+source.description+', '+source.name+'.';}
 if(input.costAdditionId){const source=(await db.query('SELECT e.entry_number FROM manufacturing_added_costs c JOIN accounting_journal_entries e ON e.workspace_id=c.workspace_id AND e.id=c.journal_entry_id WHERE c.workspace_id=$1 AND c.id=$2',[ctx.workspaceId,input.costAdditionId])).rows[0];text+=' Reverse the allocation posted in journal '+source.entry_number+'.';}
 if(result.bookings?.length)text+=' Reserve '+result.totalMinutes+' minutes: '+result.bookings.map(b=>b.day+' · operation '+(b.operation+1)+' · '+b.minutes+' minutes').join('; ')+'.';
 if(result.materialCostMinor!=null)text+=' Component value into work in progress: '+money(result.materialCostMinor)+'.';
 if(result.good!=null)text+=' Receive '+result.good+' good units at '+money(result.outputCostMinor)+' and record '+result.scrap+' scrapped units at '+money(result.scrapCostMinor)+'.';
 if(result.amountMinor!=null)text+=' Exact expense reclassification: '+money(result.amountMinor)+'.';
 if(result.writtenOffMinor!=null)text+=' Write off '+money(result.writtenOffMinor)+'; this cancellation creates no additional component return.';
 if(input.neededBy)text+=' Plan '+input.quantity+' units by '+input.neededBy+'.';
 if(input.operation!=null)text+=' Record '+input.quantity+' units at operation '+(Number(input.operation)+1)+', '+(input.actualMinutes||0)+' actual minutes.';
 if(result.recoveredCostMinor!=null)text+=' Recover '+result.quantity+' original component units at '+money(result.recoveredCostMinor)+'. Further output is blocked; recover other unused components, then cancel the remaining work and record its remaining loss.';
 if(input.reason)text+=' Reason: '+input.reason+'.';
 return text+' The exact simulated stock and journal effects are frozen for approval.';
}
const specs=contracts.map(([name,method,description,record,permission,fields])=>({
 name:'manufacturing.'+name,description:description+'. Discover actual products, BOMs, locations and job state first. Physical confirmation must be established by the user. Previews use the canonical service and save nothing; execution requires exact approval and stops if reviewed state or economic effects changed.',
 fields:[...(record?['recordReference']:[]),'manufacturingInput'],record:record||undefined,permission,capability:'inventory.core',resultingRecords:['manufacturing_work_orders','manufacturing_boms','movements','accounting_journal_entries'],
 build:async(db,ctx,row,args)=>{const input=parse(args.manufacturingInput,fields);if(method==='activateBom')input.expectedHash=row.integrity_hash;
  if(method==='createWorkOrder')input.requestKey='manufacturing-ask:'+newId('request');
  if(record==='manufacturing_work_order')input.idempotencyKey='manufacturing-ask:'+newId('request');
  const simulated=await preview(db,ctx,method,record,row?.id,input);return {payload:{recordId:row?.id||null,input,expectedState:simulated.expectedState,effects:simulated.effects},summary:await summary(db,ctx,description,input,simulated.result,record,row)};
 },
 execute:async(client,ctx,payload)=>{const current=await state(client,ctx,record,payload.recordId);if(current!==payload.expectedState)throw new ValidationError('This production record changed after review. Prepare a new approval.');const result=await invoke(client,ctx,method,payload.recordId,payload.input);if(hash(await effect(client,ctx,result))!==hash(payload.effects))throw new ValidationError('The production quantities, costs or journal effects changed. Review a fresh proposal.');return result;},
 verify:async(client,ctx,result,payload)=>hash(await effect(client,ctx,result))===hash(payload.effects),
}));
async function read(db,ctx){const overview=await require('./postgres-views').overview(db,ctx);return {rows:[{workInProgressAccountId:overview.settings?.wip_account_id||null,bomRevisions:overview.boms,workOrders:overview.jobs,workCentres:overview.centres,coverage:'Latest 100 work orders and BOM revisions; no production state inferred beyond these records.'}],sources:[{kind:'page',href:'/manufacturing',label:'Manufacturing'}]};}
module.exports={specs,read};
