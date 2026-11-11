'use strict';

function visibleHtml(value,{currentOnly=false}={}){
  if(typeof value!=='string'||!value.trim()||value.length>2000000||/<!ENTITY|<!DOCTYPE(?!\s+html\s*>)/iu.test(value))return '';
  const html=/<html[\s>]/iu.test(value)?value:'<html><body>'+value+'</body></html>';
  try{
    const {DOMParser,XMLSerializer}=require('@xmldom/xmldom');
    const ignore=()=>{};
    const doc=new DOMParser({errorHandler:{warning:ignore,error:ignore,fatalError:ignore}})
      .parseFromString(html.replace(/<!DOCTYPE\s+html\s*>/giu,''),'text/html');
    function strip(node){
      for(let child=node.firstChild;child;){
        const next=child.nextSibling;
        if(child.nodeType===1){
          const tag=String(child.localName||'').toLowerCase(),className=child.getAttribute('class')||'';
          const style=child.getAttribute('style')||'';
          const hidden=child.hasAttribute('hidden')||child.getAttribute('aria-hidden')==='true'||
            /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(style)||['template','noscript'].includes(tag);
          const quote=tag==='blockquote'||/\b(?:gmail_quote|gmail_attr|yahoo_quoted)\b/iu.test(className)||
            String(child.getAttribute('id')).toLowerCase()==='divrplyfwdmsg';
          if(hidden||currentOnly&&quote)node.removeChild(child);else strip(child);
        }
        child=next;
      }
    }
    strip(doc);
    return require('../../documents/html-source-text').text(new XMLSerializer().serializeToString(doc));
  }catch{return '';}
}

const originalReview='The original exceeds the mailbox attachment reading limit. Review this email in the connected mailbox.';
function oversized(error){return error.code==='validation_error'&&/provider response is too large/iu.test(error.message);}
module.exports={visibleHtml,oversized,originalReview};
