'use strict';const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-po-date-fixture').fixture(t),service=require('../../src/purchasing/agent-container-plans'),{db,ctx}=f,input={title:'Import load qualification',ordersText:(await f.order()).po_number,feet:'20',containerCount:'1',lengthMm:'1000',widthMm:'1000',heightMm:'1000',payloadGrams:'20000',requestKey:randomUUID(),confirmed:'yes'};
 async function prepared(extra={}){const value={...input,...extra},p=await service.prepare(db,ctx,value);return {...value,sourceFingerprint:p.facts.fingerprint,packages:p.rows.map(row=>({lineId:row.line_id,unitsPerCarton:'2',lengthMm:'500',widthMm:'500',heightMm:'500',weightGrams:'1000',maximumAboveGrams:'5000',rotate:'no',sourceReference:'Owner-measured sealed carton specification 1'}))};}
 const receive=async quantity=>f.workflows.receivePurchaseOrder(db,ctx,f.po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'PHYSICAL-CONTAINER-RECEIPT',lines:[{lineId:f.po.lineIds[0],quantity,locationId:f.location.id}]});
 return {...f,service,input,prepared,receive};
}module.exports={fixture};
