'use strict';
// Real TEST API transport for Stripe CLI device authorization. Credentials stay
// in Stripe's credential store; they are never extracted into the test process.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execute=promisify(execFile);
function createStripeCliTransport({cli,config,run=execute}){
 if(process.env.NODE_ENV!=='test'||!cli||!config)throw Error('CLI transport is restricted to explicit test configuration');
 return async function cliFetch(url,init={}){
  const target=new URL(url);const method=String(init.method||'GET').toLowerCase();
  if(target.origin!=='https://api.stripe.com'||!target.pathname.startsWith('/v1/')||!['get','post','delete'].includes(method))
   throw Error('Unexpected Stripe CLI transport destination');
  const args=['--config',config,'--color','off',method,target.pathname,'--confirm'];
  const headers=new Headers(init.headers);
  if(headers.has('Stripe-Version'))args.push('--stripe-version',headers.get('Stripe-Version'));
  if(headers.has('Idempotency-Key'))args.push('--idempotency',headers.get('Idempotency-Key'));
  for(const [key,value] of [...target.searchParams,...new URLSearchParams(init.body||'')])args.push('--data',`${key}=${value}`);
  const env={...process.env};delete env.STRIPE_API_KEY;
  let output;
  try{output=(await run(cli,args,{env,windowsHide:true,signal:init.signal,maxBuffer:8*1024*1024})).stdout;}
  catch(error){if(error.stdout?.includes('{'))output=error.stdout;else throw Error('Stripe CLI request could not complete');}
  const start=output.indexOf('{');if(start<0)throw Error('Stripe CLI returned no API response');
  const payload=JSON.parse(output.slice(start));
  return new Response(JSON.stringify(payload),{status:payload.error?400:200,headers:{'Content-Type':'application/json'}});
 };
}
module.exports={createStripeCliTransport};
