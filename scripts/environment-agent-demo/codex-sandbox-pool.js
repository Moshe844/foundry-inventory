'use strict';
// One unused, credential-free sandbox is prepared ahead of a request. Containers
// are consumed once, never returned/reused; tenant files cannot enter the spare.
function createPool({image,prepare=require('./codex-runtime').prepareSandbox}){
 let closed=false,next=null,expiry=null;
 function fill(){if(closed||next)return;const spare=Promise.resolve().then(()=>prepare(image));next=spare;spare.catch(()=>{});
  spare.then(prepared=>{if(closed||next!==spare)return;
   // Existing containers expire after twenty minutes. Renew an UNUSED spare
   // early, preserving enough lifetime for the unchanged eight-minute run.
   expiry=setTimeout(async()=>{if(closed||next!==spare)return;next=null;expiry=null;
    await prepared.sandbox.close().catch(()=>{});fill();},4*60000);expiry.unref();
  },()=>{});
 }
 fill();
 return {
  async ready(){if(closed)throw Error('SANDBOX_POOL_CLOSED');await next;},
  async take(requestedImage){
   if(closed||requestedImage!==image)throw Error('SANDBOX_POOL_SCOPE_MISMATCH');
   fill();const loan=next;next=null;clearTimeout(expiry);expiry=null;fill();const prepared=await loan;
   try{
    if(closed)throw Error('SANDBOX_POOL_CLOSED');
    // Fresh certification at checkout retains every existing isolation check.
    prepared.isolation=await prepared.sandbox.certify();return prepared;
   }catch(error){await prepared.sandbox.close().catch(()=>{});throw error;}
  },
  async close(){closed=true;clearTimeout(expiry);expiry=null;const spare=next;next=null;if(spare){const p=await spare.catch(()=>null);if(p)await p.sandbox.close();}}
 };
}
module.exports={createPool};
