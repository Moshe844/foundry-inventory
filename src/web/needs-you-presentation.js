'use strict';
const {createHash}=require('node:crypto');
const GROUPS=[['all','Everything'],['approval','Approvals'],['clarification','Questions'],['mail','Messages'],['inventory','Inventory'],['accounting','Money'],['orders','Orders & deliveries'],['connection','Connections'],['other','Other issues']];
function group(kind){return ['approval','recovery'].includes(kind)?'approval':['order','purchase','shipping'].includes(kind)?'orders':['clarification','mail','inventory','accounting','connection'].includes(kind)?kind:'other';}
function instant(value){if(!value)return null;const text=value instanceof Date?value.toISOString():String(value);if(!/T|\d \d{2}:/.test(text))return null;const time=Date.parse(text);return Number.isFinite(time)?new Date(time).toISOString():null;}
function identity(item){return createHash('sha256').update(JSON.stringify([item.kind,item.sourceId||item.approval?.proposalId||'',item.href,item.title,item.createdAt||item.at])).digest('hex').slice(0,20);}
function present(items,query={}){
 const q=typeof query.q==='string'?query.q.trim().slice(0,200):'',category=GROUPS.some(([key])=>key===query.category)?query.category:'all',sort=['priority','newest','oldest'].includes(query.sort)?query.sort:'priority';
 const rows=items.map(item=>({...item,id:identity(item),category:group(item.kind),createdAt:instant(item.createdAt||item.at),updatedAt:instant(item.updatedAt),dueDate:/^\d{4}-\d{2}-\d{2}$/.test(String(item.dueDate||''))?item.dueDate:null}));
 const counts=Object.fromEntries(GROUPS.map(([key])=>[key,key==='all'?rows.length:rows.filter(r=>r.category===key).length]));
 const visible=rows.filter(row=>(category==='all'||row.category===category)&&(!q||[row.title,row.happened,row.why,row.recommendation].some(text=>String(text||'').toLowerCase().includes(q.toLowerCase()))));
 if(sort!=='priority')visible.sort((a,b)=>{const left=Date.parse(a.createdAt||''),right=Date.parse(b.createdAt||'');if(!Number.isFinite(left))return Number.isFinite(right)?1:0;if(!Number.isFinite(right))return -1;return sort==='newest'?right-left:left-right;});
 const focus=typeof query.item==='string'?query.item:rows[Number(query.at)]?.id;
 function href(changes={}){const params=new URLSearchParams({category,q,sort,...changes});for(const[key,value]of [...params])if(!value||key==='category'&&value==='all'||key==='sort'&&value==='priority')params.delete(key);return '/needs-you'+(params.size?'?'+params.toString():'');}
 return {rows:visible,total:rows.length,urgent:rows.filter(r=>r.importance==='Urgent').length,q,category,sort,focus,groups:GROUPS.filter(([key])=>key==='all'||counts[key]).map(([key,label])=>({key,label,count:counts[key],href:href({category:key})})),href};
}
module.exports={present,instant,identity};
