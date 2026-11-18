'use strict';

// Log authority and the category of access, never customer content or a raw
// path (private links contain bearer tokens). This is awaited before disclosure.
const areas=new Set(['customers','sales','orders','purchasing','suppliers','money','accounting','mail','messages','shipping','reports','exports','settings','connections','support','ask','autopilot','operations','inventory','stock','api','billing','inventories']);
function area(path){const first=String(path||'').split('/')[1];return areas.has(first)?first:'business';}
const insert=`INSERT INTO stockchief_runtime.data_access_events(workspace_id,account_id,actor_id,channel,area,method,reference)
  VALUES($1,$2,$3,$4,$5,$6,$7)`;
async function record(db,ctx,{channel='APP',area:category='business',method='ACCESS',reference=null}={}){
 await db.query(insert,[ctx?.workspaceId||null,ctx?.accountId||null,ctx?.actorId||null,channel,category,method,reference]);
}
// A renderer with a SELECT-only database keeps that boundary. Its host can
// provide this separate sink, which accepts exactly one scoped audit INSERT.
function scopedSink(db,ctx){
 if(!ctx.workspaceId||!ctx.accountId||!ctx.actorId)throw new TypeError('A fixed audit scope is required.');
 return {query(sql,args){
  if(sql!==insert||!Array.isArray(args)||args.length!==7||args[0]!==ctx.workspaceId||args[1]!==ctx.accountId||args[2]!==ctx.actorId
   ||args[3]!=='APP'||!areas.has(args[4])&&args[4]!=='business'||!['GET','HEAD'].includes(args[5])||args[6]!==null)
   throw new Error('Inspection audit sink refused an unexpected operation.');
  return db.query(sql,args);
 }};
}
function middleware(db){return async(req,res,next)=>{
 if(!req.account||!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(req.method))return next();
 try{
  await record(db,{...req.ctx,accountId:req.account.id},{area:area(req.path),method:req.method});
  return next();
 }catch(error){
  // Billing/provider webhooks are outside this middleware. An unauditable
  // authenticated disclosure must fail closed without exposing database errors.
  console.error('[data-access] recording failed',error.code||error.name);
  return res.status(503).type('text/plain').send('Access could not be recorded. Please try again shortly.');
 }
};}
async function expire(db,{now=Date.now(),budgetMs=30000}={}){
 const cutoff=new Date(Math.min(now,Date.now())-180*86400000).toISOString(),deadline=Date.now()+budgetMs;
 let removed=0;
 while(Date.now()<deadline){
  const result=await db.query(`DELETE FROM stockchief_runtime.data_access_events WHERE id IN (
   SELECT id FROM stockchief_runtime.data_access_events WHERE created_at<$1 ORDER BY created_at,id LIMIT 1000)` ,[cutoff]);
  removed+=result.rowCount;if(result.rowCount<1000)break;
 }
 return removed;
}
async function review(db,ctx){
 const rows=(await db.query(`SELECT id,account_id,actor_id,channel,area,method,reference,created_at
  FROM stockchief_runtime.data_access_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[ctx.workspaceId])).rows;
 const last=(await db.query(`SELECT created_at FROM security_event_history WHERE workspace_id=$1
  AND action='Personal data access log reviewed' ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
 return {rows,lastReviewedAt:last?.created_at||null,retentionDays:180};
}
module.exports={record,middleware,expire,area,review,scopedSink,retentionDays:180};
