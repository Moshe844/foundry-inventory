'use strict';
const homeRoutes=Object.freeze({'inventory.receive':'/purchasing/receive','inventory.transfer':'/transfers/new','read.needs_you':'/needs-you','read.custom_report':'/reports/builder','read.inventory':'/inventory/table','policy.propose':'/reorder-rules'});
function home(entries){return entries.filter(e=>homeRoutes[e.name]).map(e=>({...e,href:homeRoutes[e.name]}));}
module.exports={home,homeRoutes};
