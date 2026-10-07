'use strict';

const {destinations}=require('../product-brain/catalog');

const routeOverrides={sales:'/orders',accounting:'/money',mail:'/mail',shipping:'/settings/shipping',
  migration:'/onboarding',imports:'/imports/start'};
const extraAliases={mail:['business email','business emails','inbox','email inbox','messages from customers',
    'messages from suppliers'],shipping:['shipping settings','carrier settings'],
  connections:['gmail settings','microsoft settings','email connection settings','integration settings'],
  sales:['orders','orders page','customer orders page'],purchasing:['purchase orders page'],
  settings:['account settings'],operations:['operations settings']};
const providerAliases={gmail:['gmail','google mail'],microsoft365:['microsoft 365','outlook'],
  quickbooks:['quickbooks'],xero:['xero'],shopify:['shopify'],woocommerce:['woocommerce'],
  square:['square'],clover:['clover']};
const providerNames={gmail:'Gmail',microsoft365:'Microsoft 365',quickbooks:'QuickBooks',xero:'Xero',
  shopify:'Shopify',woocommerce:'WooCommerce',square:'Square',clover:'Clover'};

function normalize(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}

function destinationFor(message){
  const text=normalize(message);
  const command=/^(?:please )?(?:take me to|bring me to|navigate to|go to|open|show me the|where can i find|where is the) (.+)$/.exec(text);
  if(!command)return null;
  const requested=command[1].replace(/^(?:my|our|the) /,'').replace(/ (?:page|screen|tab|section)$/,'').trim();
  if(!requested||/^(?:open|unpaid|late) (?:purchase |sales |customer )?orders?$/.test(requested))return null;
  for(const [providerType,aliases] of Object.entries(providerAliases)){
    if(aliases.some((alias)=>[alias,`${alias} connection`,`${alias} settings`,
      `${alias} connection settings`,`${alias} integration`,`${alias} integration settings`].includes(requested)))
      return {providerType,label:`${providerNames[providerType]} settings`};
  }
  const matches=destinations.flatMap((destination)=>[destination.label,...destination.aliases,
    ...(extraAliases[destination.id]||[])].map((alias)=>({destination,alias:normalize(alias)})))
    .filter(({alias})=>alias===requested);
  const unique=new Map(matches.map(({destination})=>[destination.id,destination]));
  if(unique.size!==1)return null;
  const destination=[...unique.values()][0];
  const href=routeOverrides[destination.id]||destination.href;
  return href.startsWith('/')&&!href.startsWith('//')?{href,label:destination.label}:null;
}

function connectionDestination(destination,connections){
  if(!destination?.providerType)return destination;
  const matches=connections.filter((connection)=>connection.provider_type===destination.providerType
    &&connection.status!=='disconnected');
  return matches.length===1?{href:`/settings/connections/${encodeURIComponent(matches[0].id)}`,
    label:destination.label}:{href:'/settings/connections',label:'Connections'};
}

module.exports={destinationFor,connectionDestination};
