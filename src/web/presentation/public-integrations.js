'use strict';
// The public Integrations page: every connection a business can actually make,
// and for each one what it does, what comes into StockChief, how to connect it
// step by step, and what stays in the owner's hands. Sales, email and
// accounting come from the connection catalogue; payments and shipping follow
// the setup pages inside the app, so the page never offers what the app cannot.
const registry=require('../../connections/providers/registry'),presentation=require('./connections');

const SIGN_IN='Create your StockChief account (or sign in), then open Settings → Connections.';

// How each kind of sign-in is done, in the order a person does it.
function stepsFor(p,group){
  const name=p.name;
  if(group==='Email')return [SIGN_IN,`Choose ${name} and sign in with the business mailbox. Approve the access ${name} asks for.`,
    'Choose which supplier senders StockChief may watch.','Supplier messages appear in StockChief; replies are prepared for you to review before anything is sent.'];
  if(group==='Accounting')return [SIGN_IN,`Choose ${name}, sign in to ${name} and pick your company.`,
    'StockChief reads your chart of accounts and compares the balances with its own records.',
    'Where they agree, you approve posting; nothing is written to your books before that.'];
  if(p.authMode==='application_auth')return [SIGN_IN,`Choose ${name} and enter your store address.`,
    `Approve StockChief in your ${name} admin. No plugins or scripts to install.`,
    'StockChief finds your products and starts receiving orders by itself.'];
  return [SIGN_IN,`Choose ${name} and sign in to ${name} to approve StockChief.`,
    'Check how StockChief matched your products and variants to its own.',
    'Turn on syncing when the matches look right.'];
}

const CONTROL={
  'Sales channels':['Matches are shown to you before stock or prices are written back.','Disconnect at any time; the history already in StockChief stays.'],
  Email:['Nothing is sent from your mailbox without your approval.','Only the senders you choose are read.'],
  Accounting:['Entries are posted only after the books agree and you say so.','Your accounting company stays the record of your books.'],
  Payments:['Money goes to your own merchant account and pays out to your bank. StockChief never holds it.','Disconnect at any time; payment history is kept.'],
  Shipping:['Postage is billed to your own shipping account.','Comparing rates never buys a label: every label is bought by a person.']
};

// Payments and shipping, as the app's own setup pages offer them.
const PAYMENTS=[
  {type:'stripe',name:'Stripe',description:'Collect invoice payments in your own Stripe account.',
   what:'Send invoices with a pay link and collect card payments in your own Stripe account. The account belongs to your business and pays out to your bank.',
   provides:['pay links on invoices','payments recorded against the invoice'],
   steps:[SIGN_IN,'Under Payments, choose Connect Stripe.','Sign in to the Stripe account your business already uses, or create one, and approve StockChief.',
     'Invoices can now carry a pay link; a paid invoice is recorded automatically.']},
  {type:'cardknox',name:'Sola / Cardknox',description:'Take card payments through your own Sola merchant account.',
   what:'Take card payments through your own Sola (Cardknox) merchant account. Card details go straight into Sola\'s secure fields; StockChief only receives single-use payment tokens.',
   provides:['secure card payments on invoices','payments recorded against the invoice'],
   steps:[SIGN_IN,'Under Payments, choose Connect Sola.','Paste your private transaction API key and public iFields key from your Sola portal, and choose live or sandbox.',
     'StockChief checks the keys before saving them. The private key stays encrypted on the server.']}
];
const SHIPPING_WHAT='Print shipping labels right from your orders. Rates come from your own account, and stock leaves when the parcel is handed over.';
const SHIPPING=[
  {type:'shippo',name:'Shippo',description:'Link your Shippo account in one step; no keys to copy.',
   steps:[SIGN_IN.replace('Settings → Connections','Settings → Shipping'),'Choose Link your Shippo account, sign in to Shippo and approve. (Or paste an API token from Shippo Settings → API.)',
     'Open an order, enter the weight, pick a rate and print.']},
  {type:'shipstation',name:'ShipStation',description:'Use the ShipStation account you already have.',
   steps:[SIGN_IN.replace('Settings → Connections','Settings → Shipping'),'In ShipStation open Account → API Settings, choose the V2 API and generate a key.',
     'Paste the key in StockChief; it is checked before it is saved.','Open an order, enter the weight, pick a rate and print.']},
  {type:'shipengine',name:'ShipStation API (ShipEngine)',description:'Connect a standalone ShipStation API account with its key.',
   steps:[SIGN_IN.replace('Settings → Connections','Settings → Shipping'),'In the ShipStation API dashboard open API Management and copy your key.',
     'Paste the key in StockChief; it is checked before it is saved.','Open an order, enter the weight, pick a rate and print.']},
  {type:'shipstation_custom_store',name:'ShipStation Custom Store',description:'Keep printing in ShipStation: it pulls StockChief orders and sends tracking back.',
   what:'Keep printing labels in ShipStation. ShipStation pulls your StockChief orders, and tracking comes back to StockChief when the label is printed.',
   provides:['StockChief orders in ShipStation','tracking numbers back on the order'],
   steps:[SIGN_IN.replace('Settings → Connections','Settings → Shipping'),'Open ShipStation Custom Store; StockChief shows the connection details.',
     'Enter those details in ShipStation\'s Custom Store setup.','New orders appear in ShipStation; tracking returns when you print.']}
];

function groups(){
  const known=registry.catalog().filter(p=>registry.get(p.type)&&p.type!=='supplier_email');
  const catalogued=[
    {title:'Sales channels',description:'Keep products, orders and stock connected.',providers:known.filter(p=>p.initialInventoryImport&&p.category!=='accounting')},
    {title:'Email',description:'Read business messages and prepare replies.',providers:known.filter(p=>p.category==='email'||['gmail','microsoft365'].includes(p.type))},
    {title:'Accounting',description:'Connect your accounting company and keep your records in sync.',providers:known.filter(p=>['quickbooks','xero'].includes(p.type))}
  ].map(group=>({...group,providers:group.providers.map(p=>({...p,description:presentation.description(p),
    what:p.description,provides:p.provides||[],steps:stepsFor(p,group.title),
    // Built, and switched on per business while the provider's partner approval
    // finishes (connections/launch-policy.js); its internal reason is never shown publicly.
    earlyAccess:p.available===false}))}));
  return [...catalogued,
    {title:'Payments',description:'Your customers pay your own merchant account.',providers:PAYMENTS},
    {title:'Shipping',description:'Your own provider account pays for postage.',providers:SHIPPING.map(p=>({what:SHIPPING_WHAT,provides:['live rates on each order','labels bought from your own account','tracking on the order'],...p}))}
  ].map(group=>({...group,providers:group.providers.map(p=>({...p,control:CONTROL[group.title]||[],logo:presentation.logo(p.type),id:'integration-'+p.type.replace(/[^a-z0-9]+/g,'-')}))}));
}
module.exports={groups};
