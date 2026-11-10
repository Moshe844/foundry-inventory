'use strict';
// The other half of the one-time form keys (form-request-keys.js). The first
// submission carrying a key runs. A repeat of a key that already went through
// is not run again: the person lands where the first one sent them, with a
// note that it was saved once. This guards every form-driven route the same
// way, whether or not the engine behind it checks keys itself.
//
// Only outcomes that went through are remembered. A refusal, an error, or a
// page rendered in place leaves the key free, so a corrected resend still
// runs. Redirects to other sites (payment and sign-in providers) are never
// replayed, because their links are single-use. A submission that never
// finished (the server stopped mid-request) frees its key after two minutes.
const {newId}=require('../lib/util');

const KIND='web.form_submission';
const FORM_KEY=/^form-[0-9a-f-]{36}$/;
const WAIT_MS=8000,STEP_MS=200,ABANDONED='2 minutes';
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));

async function claim(database,workspaceId,key){
  const inserted=await database.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key)
    VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[newId('pgop'),workspaceId,KIND,key]);
  if(inserted.rows.length)return true;
  const resumed=await database.query(`UPDATE stockchief_runtime.business_operations SET created_at=now()
    WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 AND status='RUNNING' AND created_at<now()-$4::interval RETURNING id`,
  [workspaceId,KIND,key,ABANDONED]);
  return resumed.rows.length>0;
}

// What the first submission came to: its result once it went through, null
// once it was refused (the key is free again), undefined while still running.
async function outcome(database,workspaceId,key){
  for(let waited=0;waited<=WAIT_MS;waited+=STEP_MS){
    const row=(await database.query(`SELECT status,result FROM stockchief_runtime.business_operations
      WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3`,[workspaceId,KIND,key])).rows[0];
    if(!row)return null;
    if(row.status==='COMPLETED')return row.result||{};
    await sleep(STEP_MS);
  }
  return undefined;
}

// A redirect back into this app, as a path; anything else is not replayable.
function samePlace(req,location){
  if(typeof location!=='string'||!location)return null;
  try{const base=`${req.protocol}://${req.get('host')}`,url=new URL(location,base+req.originalUrl);
    return url.origin===base?url.pathname+url.search+url.hash:null;}catch{return null;}
}

function back(req){return samePlace(req,req.get('referer'))||'/';}

function create(database){
  return async(req,res,next)=>{
    const key=req.method==='POST'?String(req.body?.idempotencyKey||''):'';
    const workspaceId=req.ctx?.workspaceId;
    if(!workspaceId||!FORM_KEY.test(key))return next();
    let failed=false;
    const run=()=>{
      const flash=req.flash;
      if(typeof flash==='function')req.flash=function(type,...rest){if(type==='error')failed=true;return flash.call(this,type,...rest);};
      res.on('finish',()=>{
        const location=res.statusCode>=300&&res.statusCode<400?samePlace(req,res.get('Location')):null;
        const settle=!failed&&location
          ?database.query(`UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$4::jsonb,completed_at=now()
            WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3`,[workspaceId,KIND,key,JSON.stringify({location,path:req.path})])
          :database.query(`DELETE FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 AND status='RUNNING'`,
            [workspaceId,KIND,key]);
        settle.catch((error)=>console.error('[foundry] could not settle a form submission key',error.message));
      });
      return next();
    };
    try{
      if(await claim(database,workspaceId,key))return run();
      const first=await outcome(database,workspaceId,key);
      if(first===null&&await claim(database,workspaceId,key))return run();
      if(first&&first.location){
        if(typeof req.flash==='function')req.flash('info','Already saved. That was sent twice, so StockChief recorded it once.');
        return res.redirect(303,first.location);
      }
      if(typeof req.flash==='function')req.flash('info','That is still being saved. Give it a moment, then refresh the page.');
      return res.redirect(303,back(req));
    }catch(error){return next(error);}
  };
}

module.exports={create,KIND};
