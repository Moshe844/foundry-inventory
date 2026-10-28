'use strict';
const registry=require('../../connections/providers/registry'),presentation=require('./connections');
function groups(){const known=registry.catalog().filter(p=>registry.get(p.type)&&p.type!=='supplier_email');return [
 {title:'Sales channels',description:'Keep products, orders and stock connected.',providers:known.filter(p=>p.initialInventoryImport&&p.category!=='accounting')},
 {title:'Email',description:'Read business messages and prepare replies.',providers:known.filter(p=>p.category==='email'||['gmail','microsoft365'].includes(p.type))},
 {title:'Accounting',description:'Connect your accounting company and reconcile records.',providers:known.filter(p=>['quickbooks','xero'].includes(p.type))},
 {title:'Payments',description:'Your customers pay your own merchant account.',providers:[{type:'stripe',name:'Stripe'},{type:'cardknox',name:'Sola / Cardknox'}]},
 {title:'Shipping',description:'Your own provider account pays for postage.',providers:[{type:'easypost',name:'EasyPost'},{type:'shipstation',name:'ShipStation'},{type:'shippo',name:'Shippo'},{type:'shipstation_custom_store',name:'ShipStation Custom Store'}]}
 ].map(g=>({...g,providers:g.providers.map(p=>({...p,description:presentation.description(p),logo:presentation.logo(p.type)}))}));}
module.exports={groups};
