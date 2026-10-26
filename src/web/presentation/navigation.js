'use strict';
const express=require('express');

// Page names and URLs are presentation configuration. They do not select or
// execute any business workflow; the destination retains its canonical guards.
const sections=[
 {id:'home',label:'Home',href:'/',icon:'overview',tabs:[]},
 {id:'orders',label:'Orders',href:'/orders',icon:'sales',tabs:[{label:'Orders',href:'/orders'},{label:'Returns',href:'/returns'},{label:'Customers',href:'/sales/customers'}]},
 {id:'stock',label:'Stock',href:'/inventory',icon:'inventory',tabs:[{label:'Products',href:'/inventory'},{label:'Locations',href:'/locations'},{label:'Transfers',href:'/transfers'},{label:'Counts',href:'/warehouse'}]},
 {id:'buy',label:'Buy',href:'/purchasing/orders',icon:'purchasing',tabs:[{label:'Purchase orders',href:'/purchasing/orders'},{label:'Receive stock',href:'/purchasing/receive'},{label:'Suppliers',href:'/suppliers'}]},
 {id:'money',label:'Money',href:'/money',icon:'wallet',tabs:[{label:'Overview',href:'/money'},{label:'Transactions',href:'/accounting/transactions'},{label:'P&L',href:'/accounting/reports/profit-and-loss'},{label:'Invoices',href:'/accounting/receivables'}]},
];
const footer=[{id:'reports',label:'Reports',href:'/reports',icon:'chart'},{id:'settings',label:'Settings',href:'/settings',icon:'settings'}];
const aliases=[
 ['/signup','/register'],['/help','/guide'],['/team','/settings#people'],['/settings/team','/settings#people'],['/profile','/settings#account'],['/account','/settings#account'],['/receive','/purchasing/receive'],['/sales/returns','/returns'],['/settings/billing','/billing'],
 ['/sales','/orders'],['/sales/new','/orders/new'],['/customers','/sales/customers'],['/accounting','/money'],['/accounting/books','/money'],['/money/books','/money'],['/accounting/accounts','/accounting/chart'],['/overview','/'],['/foundry/briefing','/'],
];
function withQuery(destination,original){const at=String(original).indexOf('?'),query=at<0?'':String(original).slice(at),[pathname,hash]=destination.split('#');return pathname+query+(hash?'#'+hash:'');}
function createAliasRouter(){const router=express.Router();for(const [from,to]of aliases)router.get(from,(req,res)=>res.redirect(301,withQuery(to,req.originalUrl)));
 router.get('/sales/orders/:id',(req,res)=>res.redirect(301,withQuery('/orders/'+encodeURIComponent(req.params.id),req.originalUrl)));return router;
}
function sectionFor(pathname){if(pathname==='/')return sections[0];if(/^\/(orders|sales|returns|quotes|fulfilment)(\/|$)/.test(pathname))return sections[1];if(/^\/(inventory|locations|transfers|warehouse|planning|imports)(\/|$)/.test(pathname))return sections[2];if(/^\/(purchasing|suppliers|supplier-returns)(\/|$)/.test(pathname))return sections[3];if(/^\/(money|accounting)(\/|$)/.test(pathname))return sections[4];return null;}
module.exports={sections,footer,aliases,createAliasRouter,sectionFor};
