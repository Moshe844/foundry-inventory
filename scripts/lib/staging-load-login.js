'use strict';
// Qualification uses the real CSRF/password login. No web session signing
// secret is copied to the worker and no application authentication bypass exists.
const crypto=require('node:crypto');
async function create(db,workspaceId,{users=50,base='https://stockchief-staging-web.onrender.com'}={}){
 const url=new URL(base),local=process.env.NODE_ENV==='test'&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);
 if((url.origin!=='https://stockchief-staging-web.onrender.com'&&!local)||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Normal qualification login is restricted to staging.');
 if(!/^wsp_[a-z0-9]+$/.test(workspaceId||'')||!Number.isInteger(users)||users<1||users>50)throw Error('A bounded synthetic inventory is required.');
 const password=crypto.randomBytes(32).toString('base64url')+'!Aa7',hash=require('../../src/domain/auth-service').hashPassword(password),sessions=new Set(),cookies=[];
 let owner,members=[],changed=false,closed=false;
 async function close(){
  if(closed)return;
  if(sessions.size)await db.query(`DELETE FROM stockchief_runtime.sessions WHERE sid=ANY($1::text[]) AND (data->>'accountId' IS NULL OR data->>'accountId'=ANY($2::text[]))`,[[...sessions],members.map(m=>m.account_id)]);
  if(changed)await db.query(`UPDATE accounts a SET password_hash=p.prior FROM jsonb_to_recordset($1::jsonb) p(id text,prior text) WHERE a.id=p.id AND a.password_hash=$2`,[JSON.stringify(members.map(m=>({id:m.account_id,prior:m.password_hash}))),hash]);
  closed=true;
 }
 try{
  await db.transaction(async c=>{
   owner=(await c.query(`SELECT w.id,w.name,w.owner_account_id,u.id user_id,a.email FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id JOIN users u ON u.workspace_id=w.id AND u.account_id=a.id AND u.role='owner' WHERE w.id=$1 AND w.deletion_requested_at IS NULL FOR SHARE OF w`,[workspaceId])).rows[0];
   if(!owner?.name.startsWith('Synthetic ERP release')||!owner.email.endsWith('@example.test'))throw Error('Only a dedicated synthetic staging inventory can sign in for qualification.');
   members=(await c.query(`SELECT u.id actor_id,u.account_id,a.email,a.password_hash FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 ORDER BY CASE u.role WHEN 'owner' THEN 0 ELSE 1 END,u.id LIMIT $2 FOR UPDATE OF a`,[workspaceId,users])).rows;
   if(members.length!==users||new Set(members.map(m=>m.account_id)).size!==users||members.some(m=>!m.email.endsWith('@example.test')))throw Error('Use distinct synthetic inventory members.');
   const ids=members.map(m=>m.account_id),unsafe=(await c.query(`SELECT EXISTS(SELECT 1 FROM users WHERE account_id=ANY($1::text[]) AND workspace_id<>$2) OR EXISTS(SELECT 1 FROM workspaces WHERE owner_account_id=ANY($1::text[]) AND id<>$2) OR EXISTS(SELECT 1 FROM platform_account_access WHERE account_id=ANY($1::text[]) AND disabled_at IS NOT NULL) AS unsafe`,[ids,workspaceId])).rows[0].unsafe;
   if(unsafe)throw Error('Qualification members must be enabled and exclusive to this synthetic inventory.');
   await c.query('UPDATE accounts SET password_hash=$2 WHERE id=ANY($1::text[])',[ids,hash]);
  },{isolation:'READ COMMITTED'});
  changed=true;
  for(const member of members){
   const jar=new Map();
   async function request(path,options={}){
    const response=await fetch(new URL(path,url),{...options,redirect:'manual',signal:AbortSignal.timeout(20000),headers:{cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...options.headers}});
    for(const entry of response.headers.getSetCookie()){
     const pair=entry.split(';',1)[0],i=pair.indexOf('='),name=pair.slice(0,i),value=pair.slice(i+1);jar.set(name,value);
     if(name==='foundry.sid'){const signed=decodeURIComponent(value),dot=signed.lastIndexOf('.');if(signed.startsWith('s:')&&dot>2)sessions.add(signed.slice(2,dot));}
    }
    return response;
   }
   const page=await request('/login'),html=await page.text(),csrf=/name="_csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];
   if(page.status!==200||!csrf)throw Error('The normal staging sign-in form could not load.');
   const signed=await request('/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,email:member.email,password})});await signed.arrayBuffer();
   if(signed.status!==302||signed.headers.get('location')!=='/')throw Error('Normal synthetic sign-in was refused; no load was started.');
   cookies.push([...jar].map(([k,v])=>k+'='+v).join('; '));
  }
  return {owner:{workspaceId,accountId:owner.owner_account_id,userId:owner.user_id,email:owner.email,businessName:owner.name},members:members.map(m=>({accountId:m.account_id,actorId:m.actor_id,workspaceId})),cookies,close};
 }catch(error){await close();throw error;}
}
module.exports={create};
