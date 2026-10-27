'use strict';
const express=require('express');

// Page names and URLs are presentation configuration. They do not select or
// execute any business workflow; the destination retains its canonical guards.
const sections=[
 {id:'home',label:'Home',href:'/',icon:'overview',tabs:[]},
 {id:'orders',label:'Orders',href:'/orders',icon:'sales',tabs:[{label:'Orders',href:'/orders'},{label:'Returns',href:'/returns'},{label:'Customers',href:'/sales/customers'}]},
 {id:'stock',label:'Stock',href:'/inventory',icon:'inventory',tabs:[{label:'Products',href:'/inventory'},{label:'Locations',href:'/locations'},{label:'Transfers',href:'/transfers'},{label:'Counts',href:'/warehouse/counts/new'}]},
 {id:'buy',label:'Buy',href:'/purchasing/orders',icon:'purchasing',tabs:[{label:'Purchase orders',href:'/purchasing/orders'},{label:'Receive stock',href:'/purchasing/receive'},{label:'Suppliers',href:'/suppliers'}]},
 {id:'money',label:'Money',href:'/money',icon:'wallet',tabs:[{label:'Overview',href:'/money'},{label:'Transactions',href:'/accounting/transactions'},{label:'P&L',href:'/accounting/reports/profit-and-loss'},{label:'Invoices',href:'/accounting/receivables'}]},
];
const footer=[{id:'reports',label:'Reports',href:'/reports',icon:'accounting'},{id:'settings',label:'Settings',href:'/settings',icon:'settings'}];
const aliases=[
 ['/signup','/register'],['/help','/guide'],['/team','/settings?section=team#people'],['/settings/team','/settings?section=team#people'],['/profile','/settings?section=advanced#account'],['/account','/settings?section=advanced#account'],['/receive','/purchasing/receive'],['/warehouse','/warehouse/operations'],['/sales/returns','/returns'],['/settings/billing','/billing'],
 ['/sales','/orders'],['/sales/new','/orders/new'],['/customers','/sales/customers'],['/accounting','/accounting/books'],['/money/books','/accounting/books'],['/accounting/accounts','/accounting/chart'],['/overview','/'],['/foundry/briefing','/'],
];
const settingsSectionHashes=Object.freeze({'people':'team','ask-preferences':'ai','ai-spending':'advanced','email-alerts':'notifications','account':'advanced','integrity-check':'data'});
function withQuery(destination,original){
 const next=new URL(destination,'http://stockchief.invalid'),source=new URL(original,'http://stockchief.invalid'),defaults=new URLSearchParams(next.search);
 next.search=source.search;for(const key of new Set(defaults.keys())){next.searchParams.delete(key);for(const value of defaults.getAll(key))next.searchParams.append(key,value);}
 if(!next.hash)next.hash=source.hash;return next.pathname+next.search+next.hash;
}
function canonicalHref(original){
 const source=new URL(original,'http://stockchief.invalid'),alias=aliases.find(([from])=>from===source.pathname);
 let destination=alias?.[1];if(/^\/sales\/orders\/[^/]+$/.test(source.pathname))destination=source.pathname.replace('/sales/orders/','/orders/');
 const next=new URL(destination?withQuery(destination,original):original,'http://stockchief.invalid');
 if(next.pathname==='/settings'&&!next.searchParams.has('section')&&settingsSectionHashes[next.hash.slice(1)])next.searchParams.set('section',settingsSectionHashes[next.hash.slice(1)]);
 return next.pathname+next.search+next.hash;
}
function createAliasRouter(){const router=express.Router();for(const [from,to]of aliases)router.get(from,(req,res)=>res.redirect(301,withQuery(to,req.originalUrl)));
 router.get('/sales/orders/:id',(req,res)=>res.redirect(301,withQuery('/orders/'+encodeURIComponent(req.params.id),req.originalUrl)));return router;
}
function sectionFor(pathname){if(pathname==='/')return sections[0];if(/^\/(orders|sales|returns|quotes|fulfilment)(\/|$)/.test(pathname))return sections[1];if(/^\/(inventory|locations|transfers|warehouse|planning|imports)(\/|$)/.test(pathname))return sections[2];if(/^\/(purchasing|suppliers|supplier-returns)(\/|$)/.test(pathname))return sections[3];if(/^\/(money|accounting)(\/|$)/.test(pathname))return sections[4];return null;}
module.exports={sections,footer,aliases,createAliasRouter,sectionFor,withQuery,canonicalHref,settingsSectionHashes};
