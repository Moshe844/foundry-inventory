'use strict';
const crypto=require('node:crypto'),{SaxesParser}=require('saxes'),{newId,nowIso}=require('../lib/util');
const {ValidationError,AuthenticationError}=require('../domain/errors'),credentials=require('../connections/postgres-credential-store'),money=require('../domain/currency');
const TYPE='shipstation_custom_store',PAGE_SIZE=100;
const equal=(a,b)=>{const x=crypto.createHash('sha256').update(String(a)).digest(),y=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(x,y);};
const xml=(name,value)=>'<'+name+'><![CDATA['+String(value??'').replaceAll(']]>',']]]]><![CDATA[>')+']]></'+name+'>';
function stamp(value){const d=new Date(value),pad=n=>String(n).padStart(2,'0');return pad(d.getUTCMonth()+1)+'/'+pad(d.getUTCDate())+'/'+d.getUTCFullYear()+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());}
function date(value){const m=String(value||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})$/);if(!m)throw new ValidationError('Use a UTC date in MM/dd/yyyy HH:mm format.');const d=new Date(Date.UTC(+m[3],+m[1]-1,+m[2],+m[4],+m[5]));if(d.getUTCFullYear()!==+m[3]||d.getUTCMonth()+1!==+m[1]||d.getUTCDate()!==+m[2]||+m[4]>23||+m[5]>59)throw new ValidationError('That date is not valid.');return d.toISOString();}
function notice(text){if(!String(text||'').trim())return {};const p=new SaxesParser(),stack=[],values={};let root,nodes=0;
 p.on('doctype',()=>{throw new ValidationError('Document declarations are not accepted.');});p.on('error',()=>{throw new ValidationError('The shipment notice is not valid XML.');});
 p.on('opentag',tag=>{if(++nodes>2000||stack.length>12)throw new ValidationError('The shipment notice is too complex.');if(!root)root=tag.name;stack.push({name:tag.name,text:''});});
 const add=value=>{if(stack.length)stack.at(-1).text+=value;};p.on('text',add);p.on('cdata',add);
 p.on('closetag',()=>{const node=stack.pop();if(stack.length===1){if(Object.hasOwn(values,node.name))throw new ValidationError('The shipment notice repeats a field.');values[node.name]=node.text.trim();}});p.write(String(text)).close();
 if(root!=='ShipNotice')throw new ValidationError('Expected a ShipNotice document.');return values;
}
async function setup(db,ctx){return db.transaction(async client=>{
 const user=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(user?.role!=='owner')throw new ValidationError('Only an owner can connect ShipStation Custom Store.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['shipstation-custom:'+ctx.workspaceId]);
 const prior=(await client.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND provider_type=$2 AND status=\'connected\' ORDER BY created_at LIMIT 1',[ctx.workspaceId,TYPE])).rows[0];
 if(prior)return {connectorId:prior.id,...await credentials.get(client,ctx.workspaceId,prior.id,'provider')};
 const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(client,ctx.workspaceId);await require('../commercial/entitlements').assertMeterCapacity(client,scope,'connections',1);
 const id=newId('con'),at=nowIso(),held={username:crypto.randomBytes(12).toString('hex'),password:crypto.randomBytes(32).toString('base64url')};
 await client.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'ShipStation Custom Store',$4,'["prepared parcels","tracking notifications"]','{}','connected','["SHIPMENT_EXPORT","TRACKING_READ"]','CONNECTED',$5,$6,$6)`,[id,ctx.workspaceId,TYPE+':'+id,TYPE,ctx.actorId,at]);await credentials.put(client,ctx.workspaceId,id,'provider',held);return {connectorId:id,...held};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function authenticate(db,id,header){const row=(await db.query("SELECT * FROM workspace_connectors WHERE id=$1 AND provider_type=$2 AND status='connected' AND paused_at IS NULL",[id,TYPE])).rows[0];
 let supplied='';try{if(/^Basic /i.test(header||''))supplied=Buffer.from(header.slice(6),'base64').toString('utf8');}catch{}
 const held=row?await credentials.get(db,row.workspace_id,id,'provider'):null,split=supplied.indexOf(':');if(!held||split<0||!equal(supplied.slice(0,split),held.username)||!equal(supplied.slice(split+1),held.password))throw new AuthenticationError('ShipStation Custom Store credentials were not accepted.');
 return {workspaceId:row.workspace_id,actorId:row.authorized_by_user_id,connectorId:id};
}
async function disconnect(db,ctx,id){return db.transaction(async client=>{
 const actor=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new ValidationError('Only an owner may disconnect this store.');
 const row=(await client.query('SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND provider_type=$3 FOR UPDATE',[ctx.workspaceId,id,TYPE])).rows[0];if(!row)throw new ValidationError('Choose this inventory’s Custom Store connection.');await credentials.remove(client,ctx.workspaceId,id);await client.query("UPDATE workspace_connectors SET status='disconnected',updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
 });}
async function exportParcels(db,ctx,query){const start=date(query.start_date),end=date(query.end_date),page=Number(query.page||1);if(start>end||!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid export date range and page.');
 return db.transaction(async client=>{
  const predicate=`s.workspace_id=$1 AND s.customer_return_id IS NULL AND coalesce(s.package_count,1)=1 AND s.status IN ('PACKED','SHIPPED','DELIVERED') AND s.updated_at::timestamptz BETWEEN $2::timestamptz AND $3::timestamptz`;
  const count=Number((await client.query('SELECT count(*) n FROM sales_shipments s WHERE '+predicate,[ctx.workspaceId,start,end])).rows[0].n);
  const rows=(await client.query(`SELECT s.*,o.order_number,o.order_date,o.currency,o.contact_email,o.contact_phone,c.name AS customer_name FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id WHERE ${predicate} ORDER BY s.updated_at,s.id LIMIT 100 OFFSET $4`,[ctx.workspaceId,start,end,(page-1)*PAGE_SIZE])).rows;
  const lines=(await client.query(`SELECT sl.*,l.unit_price_minor,k.code,k.weight_grams,i.name AS item_name,k.variant_label FROM sales_shipment_lines sl JOIN sales_order_lines l ON l.workspace_id=sl.workspace_id AND l.id=sl.sales_order_line_id JOIN skus k ON k.workspace_id=sl.workspace_id AND k.id=sl.sku_id JOIN items i ON i.workspace_id=k.workspace_id AND i.id=k.item_id WHERE sl.workspace_id=$1 AND sl.shipment_id=ANY($2::text[]) ORDER BY sl.shipment_id,sl.id`,[ctx.workspaceId,rows.map(r=>r.id)])).rows;
  return '<?xml version="1.0" encoding="utf-8"?><Orders pages="'+Math.max(1,Math.ceil(count/PAGE_SIZE))+'">'+rows.map(row=>{
   const items=lines.filter(l=>l.shipment_id===row.id),address=require('./address').parse(row.ship_to_address),value=money.sum(items.map(l=>money.integer(Number(l.quantity)*Number(l.unit_price_minor),'Parcel declared value')));
   return '<Order>'+xml('OrderID',row.id)+xml('OrderNumber',row.shipment_number)+xml('OrderDate',stamp(row.created_at))+xml('OrderStatus',['SHIPPED','DELIVERED'].includes(row.status)?'shipped':'awaiting_shipment')+xml('LastModified',stamp(row.updated_at))+xml('CurrencyCode',row.currency)+xml('OrderTotal',money.fromMinor(value,row.currency))+xml('InternalNotes','Fulfillment parcel for '+row.order_number+'. Invoice discounts and tax remain on the StockChief customer invoice.')+'<Customer>'+xml('CustomerCode',row.contact_email||row.sales_order_id)+'<BillTo>'+xml('Name',row.customer_name)+xml('Email',row.contact_email)+xml('Phone',row.contact_phone)+'</BillTo><ShipTo>'+xml('Name',row.customer_name)+xml('Address1',address.line1)+xml('Address2',address.line2)+xml('City',address.city)+xml('State',address.state)+xml('PostalCode',address.postalCode)+xml('Country',address.country)+xml('Phone',row.contact_phone)+'</ShipTo></Customer><Items>'+items.map(l=>'<Item>'+xml('SKU',l.code)+xml('Name',l.item_name+(l.variant_label?' / '+l.variant_label:''))+xml('Quantity',l.quantity)+xml('UnitPrice',money.fromMinor(l.unit_price_minor,row.currency))+(l.weight_grams?xml('Weight',l.weight_grams)+xml('WeightUnits','Grams'):'')+'</Item>').join('')+'</Items></Order>';
  }).join('')+'</Orders>';
 },{isolation:'REPEATABLE READ',readOnly:true});
}
async function notify(db,ctx,query,body){const n=notice(body),id=String(n.OrderID||query.order_number||'').trim(),carrier=String(n.Carrier||query.carrier||'').trim(),trackingNumber=String(n.TrackingNumber||query.tracking_number||'').trim(),service=String(n.Service||query.service||'').trim();
 if(!id||!trackingNumber||id.length>100||carrier.length>200||trackingNumber.length>240||service.length>200)throw new ValidationError('The notification needs an exact parcel and tracking number.');
 const row=(await db.query('SELECT id FROM sales_shipments WHERE workspace_id=$1 AND (id=$2 OR shipment_number=$2)',[ctx.workspaceId,id])).rows[0];if(!row)throw new ValidationError('This parcel does not belong to the connected inventory.');
 return require('./postgres-service').observeExternalLabel(db,ctx,row.id,{connectorId:ctx.connectorId,externalEventId:crypto.createHash('sha256').update(JSON.stringify([row.id,carrier,trackingNumber,service])).digest('hex'),carrier,trackingNumber,service});
}
module.exports={TYPE,setup,authenticate,exportParcels,notify,notice,date,xml,disconnect};
