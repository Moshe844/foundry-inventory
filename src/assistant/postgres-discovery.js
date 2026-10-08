'use strict';

const registry=require('./postgres-capability-registry').registry;
const permissions=require('../actions/permissions');
const entitlements=require('../entitlements/postgres-service');

function humanize(name){return name.split('.').at(-1).replace(/_/g,' ');}
function discoveryFor(contract){
  if(contract.discovery)return contract.discovery;
  if(contract.kind!=='mutation')return null;
  const label=`${humanize(contract.name)} ${contract.recordKind?.replace(/_/g,' ')||contract.name.split('.')[0].replace(/_/g,' ')}`;
  return {label:label[0].toUpperCase()+label.slice(1),prompt:`Help me ${label.toLowerCase()}`,
    rank:160,commercialCapability:contract.commercialCapability||null};
}

async function available(database,ctx){
  const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)return [];
  const facts=(await database.query(`SELECT
    (SELECT COUNT(*)::int FROM items WHERE workspace_id=$1 AND is_active=1) AS products,
    (SELECT COUNT(*)::int FROM suppliers WHERE workspace_id=$1 AND status='active') AS suppliers,
    (SELECT COUNT(*)::int FROM workspace_connectors WHERE workspace_id=$1 AND status='connected'
      AND paused_at IS NULL AND provider_type IN ('gmail','microsoft365')) AS mailboxes`,
  [ctx.workspaceId])).rows[0];
  const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  const write=await entitlements.capabilityState(database,scope,'ask.prepare_actions');
  const readPermissions=require('./postgres-control-plane').READ_PERMISSIONS;
  const checks=new Map();
  const enabled=async(key)=>{
    if(!checks.has(key))checks.set(key,(await entitlements.capabilityState(database,scope,key)).enabled);
    return checks.get(key);
  };
  const entries=[];
  for(const contract of registry.list()){
    const discovery=discoveryFor(contract);
    if(!discovery)continue;
    const permission=contract.kind==='read'?readPermissions[contract.view]||contract.permission:contract.permission;
    if(!permissions.can(actor,permission))continue;
    if(contract.ownerOnly&&actor.role!=='owner')continue;
    if(['mutation','policy'].includes(contract.kind)&&!write.enabled)continue;
    if((contract.commercialCapability||discovery.commercialCapability)&&
      !await enabled(contract.commercialCapability||discovery.commercialCapability))continue;
    if((contract.additionalCommercialCapabilities||[]).length&&
      !(await Promise.all(contract.additionalCommercialCapabilities.map(enabled))).every(Boolean))continue;
    if(discovery.requires==='mailbox'&&!Number(facts.mailboxes))continue;
    if(discovery.requires==='product'&&!Number(facts.products))continue;
    const emptyCatalog=Number(facts.products)===0;
    entries.push({name:contract.name,kind:contract.kind,label:discovery.label,prompt:discovery.prompt,
      recordKind:contract.recordKind||null,
      rank:discovery.rank+(emptyCatalog&&contract.name==='catalog.create_item'?-90:0)+
        (emptyCatalog&&/inventory|replenishment|purchase_order/.test(contract.name)?30:0),
      description:contract.description});
  }
  return entries.sort((a,b)=>a.rank-b.rank);
}

async function suggestions(database,ctx,limit=4,page=null){
  const entries=await available(database,ctx);
  const path=page?.path||'';
  const contextKind=/^\/inventory\/[^/]+$/.test(path)?'inventory':
    /^\/(?:sales\/)?orders\/[^/]+$/.test(path)?'sales_order':
      /^\/purchasing\/orders\/[^/]+$/.test(path)?'purchase_order':
        /^\/transfers\/[^/]+$/.test(path)?'transfer':
          /^\/fulfilment\/[^/]+$/.test(path)?'shipment':
            /^\/returns\/[^/]+$/.test(path)?'customer_return':null;
  const contextual=contextKind?entries.map((entry)=>({...entry,
    rank:entry.rank+(contextKind==='inventory'&&/inventory\.|read\.replenishment/.test(entry.name)?-70:0)+
      (contextKind==='sales_order'&&entry.name==='read.sales_orders'?-70:0)+
      (contextKind==='purchase_order'&&entry.name==='read.purchase_orders'?-70:0)+
      (entry.recordKind===contextKind?-120:0)}))
    .sort((left,right)=>left.rank-right.rank):entries;
  return contextual.slice(0,Math.max(0,limit)).map((entry)=>entry.prompt);
}

async function describe(database,ctx){
  const entries=await available(database,ctx);
  const selected=entries.filter((entry)=>entry.name!=='read.capabilities');
  const actions=selected.some((entry)=>entry.kind==='mutation'||entry.kind==='policy');
  const canCreateProduct=selected.some((entry)=>entry.name==='catalog.create_item');
  const productCount=canCreateProduct?(await database.query(
    'SELECT COUNT(*)::int AS total FROM items WHERE workspace_id=$1 AND is_active=1',[ctx.workspaceId]
  )).rows[0].total:null;
  const answer=selected.length
    ?`I can help with ${selected.slice(0,4).map((entry)=>entry.label.toLowerCase()).join(', ')}. `+
      (actions?'I will show you any change for approval before making it.':'I can show you the records you are allowed to see.')+
      (productCount===0?' You have no products yet; I can help add your first one.':'')
    :'I can help explain this inventory, but no additional actions are available to your account here.';
  return {status:'ANSWERED',answer,rows:selected.map((entry)=>({help:entry.label,
    howItWorks:entry.kind==='mutation'||entry.kind==='policy'?'Prepared for your approval':
      entry.kind==='navigation'?'Opens the relevant page':'Reads verified business records'})),
  columns:['help','howItWorks'],general:false};
}

module.exports={available,suggestions,describe};
