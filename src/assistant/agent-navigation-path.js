'use strict';
// A destination must come from an actual app-rendered observation. This only
// normalizes it; it is not a route catalogue and does not grant page access.
function localPath(value){
 if(typeof value!=='string'||value.length>2000||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020\u007f]/.test(value))return null;
 let decoded;try{decoded=decodeURIComponent(value);}catch{return null;}
 if(decoded.startsWith('//')||/[\\\u0000-\u001f\u007f]/.test(decoded)||/%(?:2f|5c|0[ad])/i.test(decoded))return null;
 const url=new URL(value,'https://stockchief.invalid');
 if(url.origin!=='https://stockchief.invalid'||url.pathname!==value.split(/[?#]/)[0])return null;
 return url.pathname+url.search;
}
module.exports={localPath};
