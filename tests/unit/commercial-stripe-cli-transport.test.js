'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {createStripeCliTransport}=require('../helpers/stripe-cli-transport');
test('device-authorized CLI transport keeps credentials out of arguments and preserves real request fields',async()=>{
 let recorded;
 const fetch=createStripeCliTransport({cli:'stripe.exe',config:'isolated-test.toml',run:async(...args)=>{
  recorded=args;return {stdout:'Running in sandbox\n{"id":"pi_fixture"}'};}});
 const response=await fetch('https://api.stripe.com/v1/payment_intents?expand[]=latest_charge',{
  method:'POST',headers:{Authorization:'Bearer secret-never-forward','Stripe-Version':'2026-09-30.endive','Idempotency-Key':'stable-fixture'},
  body:'amount=100&currency=usd'});
 assert.equal(response.ok,true);assert.equal((await response.json()).id,'pi_fixture');
 const args=recorded[1];assert.ok(args.includes('amount=100'));assert.ok(args.includes('expand[]=latest_charge'));
 assert.ok(args.includes('stable-fixture'));assert.ok(!args.includes('--live'));
 assert.ok(!args.join(' ').includes('secret-never-forward'));assert.equal(recorded[2].env.STRIPE_API_KEY,undefined);
 await assert.rejects(()=>fetch('https://another.example/v1/payment_intents'),/Unexpected/);
});
test('CLI transport preserves Stripe API refusal rather than returning a successful response',async()=>{
 const fetch=createStripeCliTransport({cli:'stripe.exe',config:'isolated-test.toml',run:async()=>({stdout:'{"error":{"message":"card declined"}}'})});
 const response=await fetch('https://api.stripe.com/v1/payment_intents',{method:'POST'});
 assert.equal(response.ok,false);assert.equal((await response.json()).error.message,'card declined');
});
