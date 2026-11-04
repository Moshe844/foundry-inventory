'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTokenCounter,policy}=require('../../scripts/environment-agent-demo/codex-token-counter');
const wire=require('../../scripts/environment-agent-demo/codex-wire');
const request={model:wire.MODEL,reasoning:{effort:wire.EFFORT},input:[{role:'user',content:'Read stock, café, 咖啡 ☕.'}]};
test('native token admission is local, conservative and never calls the provider',async()=>{
 let calls=0;const counter=createTokenCounter({apiKey:'FAKE',fetchImpl:()=>{calls++;throw Error('NO_TOKEN_COUNT_HTTP');}});
 const before=structuredClone(request),count=await counter(request),priced=wire.counted(wire.normalize(request),count);
 assert.equal(calls,0);assert.equal(policy.networkRequests,0);assert.equal(count.basis,'local_conservative_bound');
 assert(count.input_tokens>=Buffer.byteLength(JSON.stringify(request))+8192);
 assert.equal(priced.upperBoundMicroUsd,Math.ceil(count.input_tokens*wire.PRICES.input+priced.outputTokens*wire.PRICES.output));
 assert.deepEqual(request,before);
});
test('opaque reasoning and each bounded image have independent token allowances',async()=>{
 const counter=createTokenCounter(),plain=await counter(request);
 const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47,0);png.writeUInt32BE(0x0d0a1a0a,4);png.write('IHDR',12);png.writeUInt32BE(1280,16);png.writeUInt32BE(900,20);
 const value=await counter({...request,input:[...request.input,{type:'reasoning',encrypted_content:'opaque'},{role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}]});
 assert(value.input_tokens>=plain.input_tokens+3000+20000);
});
test('local admission rejects unbounded context and retains the existing context ceiling',async()=>{
 const counter=createTokenCounter();
 for(const item of [{type:'input_file',file_id:'remote'},{type:'compaction',encrypted_content:'unknown'},{type:'input_image',image_url:'https://example.test/a.png'}])await assert.rejects(counter({...request,input:[item]}));
 const count=await counter({...request,input:[{role:'user',content:'x'.repeat(wire.MAX_INPUT_TOKENS)}]});
 assert.throws(()=>wire.counted(wire.normalize(request),count),/INVALID_CODEX_TOKEN_COUNT/);
});
test('local input bound does not discount cached tokens or lower output reservations',async()=>{
 const counter=createTokenCounter();const short=await counter(request),long=await counter({...request,input:[{role:'user',content:'x'.repeat(10000)}]});
 assert(long.input_tokens>short.input_tokens);const a=wire.counted(wire.normalize(request),short),b=wire.counted(wire.normalize({...request,max_output_tokens:100}),short);
 assert.equal(a.outputTokens,3000);assert(a.upperBoundMicroUsd>b.upperBoundMicroUsd);
});
