'use strict';
// Every form that changes something carries a one-time key, so the same
// submission sent twice (a double tap, a resend after Back, a dropped
// connection retried) is recorded once: the engines replay the first result
// for a key they have already seen. Forms that bring their own key keep it.
//
// Done here, on the way out, so it covers every page and layout (including
// screens that load no scripts) and any form added later, with no template
// having to remember. Each page sent gets fresh keys, so a new visit is a new
// submission. Scripts are left untouched, and forms that post to another site
// get nothing.
const {randomUUID}=require('node:crypto');

// One pass over the page's tags, so the time is linear in the page whatever its
// shape (unclosed forms or scripts cannot make it rescan the rest of the page).
const TAGS=/<script\b[^>]*>|<\/script\s*>|<form\b([^>]*)>|<\/form\s*>/gi;
const POSTS=/\bmethod\s*=\s*["']?post\b/i;
const OWN_KEY=/\bname\s*=\s*["']?idempotencyKey\b/;
const ACTION=/\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function key(){return 'form-'+randomUUID();}

function needsKey(attrs){
  if(!POSTS.test(attrs))return false;
  const match=ACTION.exec(attrs),action=match?(match[1]??match[2]??match[3]):'';
  return !(/^[a-z][a-z0-9+.-]*:/i.test(action)||action.startsWith('//'));
}

function withKeys(html){
  if(typeof html!=='string'||!/<form\b/i.test(html))return html;
  const inserts=[];let inScript=false,open=null,match;
  TAGS.lastIndex=0;
  while((match=TAGS.exec(html))){
    const tag=match[0],lower=tag.slice(0,8).toLowerCase();
    if(lower.startsWith('<script')){inScript=true;continue;}
    if(lower.startsWith('</script')){inScript=false;continue;}
    if(inScript)continue;
    if(lower.startsWith('<form')){open=needsKey(match[1]||'')?{at:match.index+tag.length}:null;continue;}
    // A closing tag: the form between them gets a key unless it brought its own.
    if(open&&!OWN_KEY.test(html.slice(open.at,match.index)))inserts.push(open.at);
    open=null;
  }
  if(!inserts.length)return html;
  let out='',from=0;
  for(const at of inserts){out+=html.slice(from,at)+`<input type="hidden" name="idempotencyKey" value="${key()}">`;from=at;}
  return out+html.slice(from);
}

function middleware(req,res,next){
  const send=res.send;
  res.send=function(body){
    const type=res.get('Content-Type');
    if(typeof body==='string'&&(type?/text\/html/i.test(type):/^\s*</.test(body)))body=withKeys(body);
    return send.call(this,body);
  };
  next();
}

module.exports={middleware,withKeys};
