'use strict';
const navigation=require('./navigation');
const destinations=[...navigation.sections,...navigation.footer,...navigation.sections.flatMap(s=>s.tabs)]
 .filter(d=>!/\/(new|receive)$/.test(d.href));
function parent(path){return destinations.filter(d=>d.href!=='/'&&(path===d.href||path.startsWith(d.href+'/'))).sort((a,b)=>b.href.length-a.href.length)[0]||null;}
function resolve(currentHref,sourceHref,labels={}){
 const current=new URL(currentHref,'http://stockchief.invalid'),source=new URL(sourceHref,'http://stockchief.invalid');
 if(current.pathname===source.pathname)return null;
 const currentList=destinations.find(d=>d.href===current.pathname),sourceList=parent(source.pathname);
 // A collection reached after deleting a record must never return to that record.
 if(currentList&&source.pathname.startsWith(current.pathname.replace(/\/$/,'')+'/')){
  if(current.pathname==='/')return null;
  const section=navigation.sectionFor(current.pathname);
  return section&&section.href!==current.pathname?{href:section.href,label:section.label}:{href:'/',label:'Home'};
 }
 // Redirects after saving often retain the creation/edit form as the referrer.
 if(/\/(new|edit)$/.test(source.pathname)&&sourceList)return {href:sourceList.href,label:sourceList.label};
 const href=source.pathname+source.search,label=labels[href]||destinations.find(d=>d.href===source.pathname)?.label;
 return label?{href,label}:null;
}
module.exports={resolve};
