'use strict';
const fs=require('node:fs');
const path=require('node:path');
// The order is explicit and shared. Existing screen vocabularies remain aliases
// while their common tokens and components are owned by product-system.css.
const sources=Object.freeze(['app.css','product-clarity.css','foundry.css','room.css','design.css','owner-workspaces.css','product-system.css']);
let cached;
function stylesheet(){
  if(cached===undefined)cached=sources.map(file=>'/* '+file+' */\n'+fs.readFileSync(path.join(__dirname,'../public',file),'utf8')).join('\n');
  return cached;
}
module.exports={sources,stylesheet};
