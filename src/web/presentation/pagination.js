'use strict';
// One way to page through a long list: 25 rows unless the person chose more.
const SIZES=Object.freeze([25,50,75]);
const MAX_PAGE=1000000;

function pageSize(req){
  const asked=Number(req.query?.rows);
  if(SIZES.includes(asked)){if(req.session)req.session.listPageSize=asked;return asked;}
  return SIZES.includes(req.session?.listPageSize)?req.session.listPageSize:SIZES[0];
}
function pageNumber(req){return Math.min(MAX_PAGE,Math.max(1,Number.parseInt(req.query?.page,10)||1));}
function hrefWith(req,changes){
  const url=new URL(req.originalUrl,'http://local');
  for(const [key,value] of Object.entries(changes)){if(value===null||value===undefined||value==='')url.searchParams.delete(key);else url.searchParams.set(key,String(value));}
  return url.pathname+url.search;
}
// What the pager draws. total is null for a list that only knows whether more follow.
function pager(req,{page,size,total=null,hasMore=false,shown=0,next={}}){
  const pages=total===null?null:Math.max(1,Math.ceil(total/size));
  const hasNext=total===null?hasMore:page<pages;
  const from=(total===0||shown===0)?0:(page-1)*size+1;
  const hidden=[...new URL(req.originalUrl,'http://local').searchParams].filter(([key])=>!['rows','page','after','offset'].includes(key));
  return {page,pages,size,sizes:SIZES,total,from,to:from?from+shown-1:0,hidden,
    show:total===null?page>1||hasMore||size>SIZES[0]:total>SIZES[0]||size>SIZES[0],
    previousHref:page>1?hrefWith(req,{page:page===2?null:page-1,after:null,offset:null}):null,
    nextHref:hasNext?hrefWith(req,{page:page+1,offset:null,...next}):null};
}
// A list already in memory.
function slice(req,rows,size=pageSize(req)){
  const pages=Math.max(1,Math.ceil(rows.length/size)),page=Math.min(pages,pageNumber(req));
  const shown=rows.slice((page-1)*size,page*size);
  return {rows:shown,pager:pager(req,{page,size,total:rows.length,shown:shown.length})};
}
// A query that reads one row more than it shows, to learn whether more follow.
function window(req){const size=pageSize(req),page=pageNumber(req);return {size,page,limit:size+1,offset:(page-1)*size};}
function fromWindow(req,found,{size,page},total=null){
  const rows=found.slice(0,size);
  return {rows,pager:pager(req,{page,size,total,hasMore:found.length>size,shown:rows.length})};
}
module.exports={SIZES,pageSize,pageNumber,hrefWith,pager,slice,window,fromWindow};
