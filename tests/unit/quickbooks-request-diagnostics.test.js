'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {providerFetch}=require('../../src/lib/provider-http');

test('QuickBooks response diagnostics retain only correlation ID, status and attempt',async t=>{
  const logs=[];t.mock.method(console,'info',(...args)=>logs.push(args));
  for(const status of [200,400,401,500]){
    let attempt=0;
    const operation=providerFetch('https://sandbox-quickbooks.api.intuit.com/v3/company/PRIVATE_REALM/query?query=PRIVATE_DATA',
      {method:'POST',headers:{authorization:'Bearer PRIVATE_TOKEN'},body:'PRIVATE_REQUEST'},
      {provider:'QuickBooks',fetch:async()=>{attempt++;return new Response('PRIVATE_RESPONSE',{status,headers:{intuit_tid:'gw-example-'+status}});}});
    if(status===500)await assert.rejects(operation,e=>e.intuitTid==='gw-example-500'&&e.attempts===1);
    else assert.equal((await operation).status,status);
    assert.equal(attempt,1);
  }
  assert.deepEqual(logs.map(row=>JSON.parse(row[1])),[200,400,401,500].map(httpStatus=>({intuitTid:'gw-example-'+httpStatus,httpStatus,attempt:1})));
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|Bearer|company\//);
});

test('QuickBooks retries preserve each response ID, but unrelated hosts and malformed IDs produce no diagnostics',async t=>{
  const logs=[];t.mock.method(console,'info',(...args)=>logs.push(args));let n=0;
  await providerFetch('https://quickbooks.api.intuit.com/v3/company/PRIVATE_REALM/query',{},
    {provider:'QuickBooks',sleep:async()=>{},fetch:async()=>Response.json({}, {status:++n<3?503:200,headers:{intuit_tid:'attempt-'+n}})});
  assert.deepEqual(logs.map(row=>JSON.parse(row[1]).intuitTid),['attempt-1','attempt-2','attempt-3']);
  for(const [url,id] of [['https://intuit.example.test/','valid-looking'],['https://oauth.platform.intuit.com/','<PRIVATE>'],['https://developer.api.intuit.com/','x'.repeat(129)],['https://quickbooks.api.intuit.com/','']])
    await providerFetch(url,{}, {fetch:async()=>Response.json({},{headers:{intuit_tid:id}})});
  assert.equal(logs.length,3);
});
