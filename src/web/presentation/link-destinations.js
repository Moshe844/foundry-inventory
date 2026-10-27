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
   const canonical=require('./navigation').canonicalHref(raw);
   if(canonical!==raw){
    quoted='"'+canonical.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"';
    tag=tag.replace(href[0],'href='+quoted);
   }
  }
  return tag.slice(0,-1)+' data-dest='+quoted+'>';
 });
}
module.exports={declare};
