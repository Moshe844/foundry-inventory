'use strict';
// Preserve the rendered destination independently of client-side enhancement.
// Specific workflow labels are also checked against the separate CI route map.
function declare(html){
 return String(html).replace(/<a\b([^>]*?)>/gi,(tag,attributes)=>{
  if(/\bdata-dest\s*=/.test(attributes))return tag;
  const href=/\bhref\s*=\s*("[^"]*"|'[^']*')/i.exec(attributes);
  if(!href)return tag;
  let quoted=href[1];
  const raw=quoted.slice(1,-1).replaceAll('&amp;','&');
  if(raw.startsWith('/')&&!raw.startsWith('//')){
   const url=new URL(raw,'http://stockchief.invalid');
   const alias=require('./navigation').aliases.find(([from])=>from===url.pathname);
   let canonical=alias?.[1];
   if(/^\/sales\/orders\/[^/]+$/.test(url.pathname))canonical=url.pathname.replace('/sales/orders/','/orders/');
   if(canonical){const next=new URL(canonical,'http://stockchief.invalid');next.search=url.search;if(!next.hash)next.hash=url.hash;
    quoted='"'+(next.pathname+next.search+next.hash).replaceAll('&','&amp;').replaceAll('"','&quot;')+'"';
    tag=tag.replace(href[0],'href='+quoted);
   }
  }
  return tag.slice(0,-1)+' data-dest='+quoted+'>';
 });
}
module.exports={declare};
