'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const base='../../scripts/environment-agent-demo/',native=require(base+'codex-wire'),legacy=require(base+'wire-policy');
test('recorded Sol request plus recorded Home observation crosses byte estimate but admits exact native counting',()=>{
 const dir='data/environment-agent-demo/codex-sdk-sol-high/attempt/';
 const last=JSON.parse(fs.readFileSync(dir+'native-count-request-13.json'));
 const goal=JSON.parse(fs.readFileSync(dir+'goal.json')),journal=goal.checkpoint.harness.evidence;
 const home=Object.values(journal).filter(e=>e.name==='environment_browser').at(-1);
 // The blocked #14 packet was not recorded. This is an explicit reconstruction
 // of the observed growth, NOT a claim to possess that missing provider packet.
 const grown={...last,input:[...last.input,{role:'user',content:home.text}]};
 assert.throws(()=>legacy.normalize('openai',grown),/INPUT_LIMIT/);
 const n=native.normalize(grown);assert.equal(n.inputTokens,null);
 assert.deepEqual(native.countRequest(n.body),grown);
 assert.equal(native.counted(n,{object:'response.input_tokens',input_tokens:36969}).upperBoundMicroUsd,122423);
 const history={...last,input:[...last.input,...Array.from({length:49},()=>({type:'reasoning',encrypted_content:'opaque'}))]};
 assert.throws(()=>legacy.normalize('openai',history),/REASONING_HISTORY_LIMIT/);
 assert.doesNotThrow(()=>native.normalize(history));
 const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47);png.writeUInt32BE(0x0d0a1a0a,4);png.write('IHDR',12);png.writeUInt32BE(1280,16);png.writeUInt32BE(900,20);
 const images={...last,input:[{role:'user',content:Array.from({length:5},()=>({type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}))}]};
 assert.throws(()=>legacy.normalize('openai',images),/IMAGE_LIMIT/);assert.doesNotThrow(()=>native.normalize(images));
 assert.throws(()=>native.normalize({...last,input:[{role:'user',content:'x'.repeat(2*1024*1024)}]}),/REQUEST_TOO_LARGE/);
 assert.throws(()=>native.normalize({...last,tools:[{type:'namespace',tools:[{type:'web_search'}]}]}),/HOSTED_TOOLS/);
});
test('native custom tool rounds are validated, and economic compaction precedes request admission',()=>{
 const validate=require(base+'protocol').validate;
 const call={type:'custom_tool_call',name:'exec',call_id:'c',input:'text(1)'};
 assert.equal(validate('openai',{input:[call,{type:'custom_tool_call_output',call_id:'c',output:'1'}]}),true);
 assert.throws(()=>validate('openai',{input:[call]}),/unfinished/);
 assert.throws(()=>validate('openai',{input:[{type:'custom_tool_call_output',call_id:'absent',output:'1'}]}),/orphan/);
 assert.equal(native.nativeCompactionTokenLimit,75600);
 assert(native.counted(native.normalize({...JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-sol-high/attempt/native-count-request-13.json'))}),
  {object:'response.input_tokens',input_tokens:108000}).upperBoundMicroUsd<=300000);
});
test('native usage requires correct model, tier and non-overlapping cache totals',()=>{
 assert.throws(()=>native.receipt({returnedModel:native.MODEL,returnedServiceTier:'priority'}),/SERVICE_TIER/);
 assert.throws(()=>legacy.usage('openai',[{object:'response',usage:{input_tokens:10,output_tokens:1,input_tokens_details:{cached_tokens:11}}}]),/CACHE_USAGE/);
});
test('visual observations and direct references remain retrievable; native indexes show the newest evidence first',()=>{
 const observations=require(base+'observations'),h={candidate:'codex'};
 const result={screen:{url:'https://fixture.invalid/',controls:[],text:'Visual-only evidence'},image:{mimeType:'image/png',base64:Buffer.from('offline-pixel-fixture').toString('base64')}};
 observations.store(h,{id:'g:1',name:'environment_browser',result,at:'2026-10-12T00:00:00Z'});
 observations.store(h,{id:'g:2',name:'environment_browser',result:{url:'https://fixture.invalid/changed'},at:'2026-10-12T00:00:01Z'});
 assert.equal(observations.index(h)[0].id,'g:2');const restored=observations.retrieve(h,{id:'g:1'});
 assert.deepEqual(restored.image,result.image);assert.equal(restored.screen.historical,true);assert.equal(restored.screen.sha256,h.evidence['g:1'].sha256);
});
