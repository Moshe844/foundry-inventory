'use strict';
const {newId}=require('../lib/util'),{ValidationError}=require('./errors'),physical=require('./physical-stock-input');
const key=r=>JSON.stringify([r.sku_id,r.id||null,r.id?null:r.code]);
// Resolve the same identities as a single receipt, with one bounded batch of
// reads/writes. Existing lot metadata remains authoritative on later receipts.
async function resolve(client,ctx,values,targets,at){
 const requests=new Map(),byPosition=new Map();
 for(const value of values){const row=targets[value.index];if(row.tracking_mode!=='lot')continue;
  const input=value.input,occurredAt=input.occurredAt||at;physical.validate({...input,lotReceivedAt:input.lotReceivedAt||occurredAt});
  if(!input.lotId&&!input.lotCode)throw new ValidationError('Lot or batch number is required.');
  const request={sku_id:row.id,id:input.lotId||null,code:input.lotId?null:String(input.lotCode),received_at:input.lotReceivedAt||occurredAt,expires_at:input.expiresAt||null,note:input.notes||null};
  const identity=key(request);if(!requests.has(identity))requests.set(identity,request);byPosition.set(value.index,identity);
 }
 if(!requests.size)return new Map();
 const payload=JSON.stringify([...requests.values()]),skuIds=[...new Set([...requests.values()].map(r=>r.sku_id))];
 const read=()=>client.query(`SELECT l.* FROM lots l JOIN jsonb_to_recordset($2::jsonb) AS x(sku_id text,id text,code text)
  ON l.sku_id=x.sku_id AND ((x.id IS NOT NULL AND l.id=x.id) OR (x.id IS NULL AND l.code=x.code))
  WHERE l.workspace_id=$1 AND l.sku_id=ANY($3::text[]) ORDER BY l.id FOR UPDATE OF l`,[ctx.workspaceId,payload,skuIds]);
 let rows=(await read()).rows;
 const find=r=>rows.find(l=>l.sku_id===r.sku_id&&(r.id?l.id===r.id:l.code===r.code));
 const missing=[...requests.values()].filter(r=>!find(r));
 if(missing.some(r=>r.id))throw new ValidationError('That lot is not in this inventory item.');
 if(missing.length){
  const fresh=missing.map(r=>({...r,id:newId('lot')})).sort((a,b)=>a.sku_id.localeCompare(b.sku_id)||a.code.localeCompare(b.code));
  await client.query(`INSERT INTO lots(id,workspace_id,sku_id,code,received_at,expires_at,note,created_at)
   SELECT x.id,$1,x.sku_id,x.code,x.received_at,x.expires_at,x.note,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text,sku_id text,code text,received_at text,expires_at text,note text)
   ORDER BY x.sku_id,x.code ON CONFLICT(workspace_id,sku_id,code) DO NOTHING`,[ctx.workspaceId,JSON.stringify(fresh),at]);
  rows=(await read()).rows;
 }
 const resolved=new Map([...requests].map(([identity,r])=>[identity,find(r)]));
 if([...resolved.values()].some(l=>!l))throw new ValidationError('A received lot could not be identified. Retry this receipt.');
 return new Map([...byPosition].map(([position,identity])=>[position,resolved.get(identity)]));
}
module.exports={resolve};
