'use strict';
// Lossless tool encoding shared by delivery and verification. The journal
// always keeps original observations. Neither encoding grants execution rights.
function project(name,value){
 if(name==='environment_browser')return require('./browser-presentation').compact(value);
 if(name==='environment_interfaces')return require('./interface-presentation').compact(value);
 return value;
}
function locate(value,pointer){
 for(const part of pointer.slice(1).split('/')){
  const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
  if(['__proto__','constructor','prototype'].includes(key)||value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {found:false};
  value=value[key];
 }
 return {found:true,value};
}
module.exports={project,locate};
