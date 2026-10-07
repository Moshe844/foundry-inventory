'use strict';

const {destinations}=require('../product-brain/catalog');

const routeOverrides={sales:'/orders',accounting:'/money',mail:'/mail',shipping:'/settings/shipping',
  migration:'/onboarding',imports:'/imports/start'};
const extraAliases={mail:['business email','business emails','inbox','email inbox','messages from customers',
    'messages from suppliers'],shipping:['shipping settings','carrier settings'],
  connections:['gmail settings','microsoft settings','email connection settings','integration settings'],
  sales:['orders','orders page','customer orders page'],purchasing:['purchase orders page'],
  settings:['account settings'],operations:['operations settings']};

function normalize(value){return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');}

function destinationFor(message){
  const text=normalize(message);
  const command=/^(?:please )?(?:take me to|bring me to|navigate to|go to|open|show me the|where can i find|where is the) (.+)$/.exec(text);
  if(!command)return null;
  const requested=command[1].replace(/^(?:my|our|the) /,'').replace(/ (?:page|screen|tab|section)$/,'').trim();
  if(!requested||/^(?:open|unpaid|late) (?:purchase |sales |customer )?orders?$/.test(requested))return null;
  const matches=destinations.flatMap((destination)=>[destination.label,...destination.aliases,
    ...(extraAliases[destination.id]||[])].map((alias)=>({destination,alias:normalize(alias)})))
    .filter(({alias})=>alias===requested);
  const unique=new Map(matches.map(({destination})=>[destination.id,destination]));
  if(unique.size!==1)return null;
  const destination=[...unique.values()][0];
  const href=routeOverrides[destination.id]||destination.href;
  return href.startsWith('/')&&!href.startsWith('//')?{href,label:destination.label}:null;
}

module.exports={destinationFor};
