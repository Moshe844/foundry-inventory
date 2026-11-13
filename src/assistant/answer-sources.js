'use strict';
// Job 153: the records behind an answer. Every answer that read records keeps
// links to them: the list or review filtered to what the answer counted, and
// up to twelve of the records themselves. Only local StockChief pages are kept,
// and a person is shown only the pages their role may open (job 203: costs,
// margins and money pages stay with the roles that may see them).
const permissions=require('../actions/permissions');
const RECORDS=12,PAGES=4;
// Agent reviews name each row by its record, not by a fixed first column.
const NAMED=['Order','Bill','Invoice','Transfer','SKU','Product','Customer','Supplier','Activity','Month','Step',
 'order','number','reference','product','name','sku','title','customer','supplier','location'];
// Ways onward that are not records: plans, upgrades, Ask itself, signing in,
// and the editors for a report (its run and its sources are the records).
const NOT_RECORDS=/^\/(?:ask|upgrade|billing|login|logout|support)(?:[/?#]|$)|^\/reports\/(?:compose|from-ask\/[^/?#]+(?:[?#]|$))/;

function local(href){
 const path=typeof href==='string'?href.trim():'';
 return /^\/(?!\/)/.test(path)&&!/[\\\s]/.test(path)&&path.length<=600?path:null;
}
const scalar=value=>value!==null&&value!==undefined&&typeof value!=='object'&&String(value).trim()!=='';
function rowLabel(row,columns){
 const first=columns.find(column=>column!=='href');
 if(first&&scalar(row[first]))return String(row[first]);
 const named=NAMED.find(key=>scalar(row[key]));
 return named?String(row[named]):'Record';
}
function bound(links){
 return [...links.filter(link=>link.kind!=='record').slice(0,PAGES),...links.filter(link=>link.kind==='record').slice(0,RECORDS)];
}
// The pages and records one result read: its own sources (a filtered review and
// its records), the list it hands over to, and each row's record.
function collect(result){
 const links=[],seen=new Set();
 const add=(kind,href,label)=>{const path=local(href);if(!path||NOT_RECORDS.test(path)||seen.has(path))return;
  seen.add(path);links.push({kind,href:path,label:String(label??'').trim().slice(0,120)||(kind==='record'?'Record':'Matching records')});};
 for(const source of Array.isArray(result?.sources)?result.sources:[])add(source?.kind==='record'?'record':'page',source?.href,source?.label);
 if(result?.handoff)add('page',result.handoff.href,result.handoff.label);
 const columns=Array.isArray(result?.columns)?result.columns:[];
 for(const row of Array.isArray(result?.rows)?result.rows:[]){
  if(links.filter(link=>link.kind==='record').length>=RECORDS)break;
  if(row&&typeof row==='object')add('record',row.href??row.link,rowLabel(row,columns));
 }
 return bound(links);
}
function merge(...lists){
 const seen=new Set(),links=[];
 for(const link of lists.flat())if(link&&local(link.href)&&!seen.has(link.href)){seen.add(link.href);links.push({kind:link.kind==='record'?'record':'page',href:link.href,label:String(link.label||'').slice(0,120)});}
 return bound(links);
}

// Which pages a role may open. The most specific path wins; a page not listed
// needs only ordinary access. The pages themselves still check access.
const P=permissions;
const RULES=[
 ['/autopilot/reviews','owner'],['/autopilot/landed-costs',P.VIEW_ACCOUNTING],['/autopilot/work',P.VIEW_PURCHASING],
 ['/money',P.VIEW_ACCOUNTING],['/accounting',P.VIEW_ACCOUNTING],
 ['/purchasing',P.VIEW_PURCHASING],['/suppliers',P.VIEW_PURCHASING],['/supplier-returns',P.VIEW_PURCHASING],
 ['/orders',P.VIEW_SALES],['/sales',P.VIEW_SALES],['/customers',P.VIEW_SALES],['/quotes',P.VIEW_SALES],
 ['/returns',P.VIEW_SALES],['/fulfilment',P.VIEW_SALES],['/transfers',P.VIEW_TRANSFERS],['/settings',P.ADMIN],
 // Record pages named by the canonical record destinations.
 ...Object.values(require('../web/postgres-record-destinations').RECORDS).flatMap(record=>{
  const prefix=record.href({id:'\u0000',item_id:'\u0000'}).split('\u0000')[0].replace(/[/#?]+$/,'');
  return [[record.collection.href,record.permission],...(prefix.length>1?[[prefix,record.permission]]:[])];
 }),
].sort((left,right)=>right[0].length-left[0].length);
function required(path){
 const bare=path.replace(/[?#].*$/,'');
 return RULES.find(([prefix])=>bare===prefix||bare.startsWith(prefix+'/'))?.[1]||P.VIEW;
}
function visible(actor,links){
 if(!actor)return [];
 return (Array.isArray(links)?links:[]).map(link=>typeof link==='string'?{href:link,kind:'record',label:'Source record'}:link).filter(link=>{const path=local(link?.href);if(!path)return false;
  const need=required(path);return need==='owner'?actor.role==='owner':permissions.can(actor,need);});
}
module.exports={collect,merge,visible,required,RECORDS};
