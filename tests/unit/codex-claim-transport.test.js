'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Ajv=require('ajv'),wire=require('../../scripts/environment-agent-demo/codex-report'),conversation=require('../../src/assistant/agent-conversation');
function grouped(report){
 const result={version:2,status:report.status,outcome:report.outcome??null,answer:report.answer??null,question:report.question??null,missingInformation:report.missingInformation||[],tier:report.tier??null,reason:report.reason??null,claims:[],navigation:report.navigation??null,workProducts:report.workProducts||[],nextActions:report.nextActions||[]};
 for(const c of report.claims||[]){let group=result.claims.at(-1);if(!group||group.evidenceId!==c.evidenceId||group.historical!==Boolean(c.historical))result.claims.push(group={evidenceId:c.evidenceId,historical:Boolean(c.historical),values:[]});group.values.push({path:c.path,value:c.value!==null&&typeof c.value==='object'?{json:JSON.stringify(c.value)}:c.value});}
 return result;
}
test('actual 37-claim live form report becomes smaller without losing any independently verifiable fact',()=>{
 const f=require('../fixtures/codex-recorded-final-claims.json'),input=f.report,packet=grouped(input),valid=new Ajv({strict:false}).compile(wire.legacySchema);assert(valid(packet),JSON.stringify(valid.errors));
 assert.equal(new Ajv({strict:false}).compile(wire.schema)(packet),false,'New native generation cannot reconstruct legacy observation IDs and field paths; stored reports remain losslessly decoded');
 const decoded=conversation.parse(wire.decode(JSON.stringify(packet)));assert.deepEqual(decoded.claims,input.claims);assert.equal(decoded.answer,input.answer);assert.equal(decoded.claims.length,37);
 const legacy={...packet,version:1,claims:input.claims.map(c=>({...c,valueJson:null}))},legacyBytes=Buffer.byteLength(JSON.stringify(legacy)),groupedBytes=Buffer.byteLength(JSON.stringify(packet));assert(groupedBytes<legacyBytes*.7,'Real metadata overhead must be reduced, not just moved to another field');
 assert.equal(conversation.classify({report:decoded,verified:false}).status,'BLOCKED','Compression cannot grant verification');
});
test('lossless grouped reports preserve null, false, zero, arrays, objects and historical/current separation',()=>{
 const claims=[{evidenceId:'same',historical:false,path:'/zero',value:0},{evidenceId:'same',historical:false,path:'/false',value:false},{evidenceId:'same',historical:false,path:'/nil',value:null},{evidenceId:'same',historical:false,path:'/lines',value:[{unknown:'field',cost:1.25}]},{evidenceId:'same',historical:true,path:'/address',value:{'unfamiliar/key':'old'}},{evidenceId:'same',historical:false,path:'/tabs',value:'Now\t0\t—'}],packet=grouped({status:'completed',outcome:'answer',answer:'Recorded result',claims});assert.deepEqual(JSON.parse(wire.decode(JSON.stringify(packet))).claims,claims);
 for(const [status,extra]of [['needs_user',{question:'Which location?',missingInformation:['location']}],['needs_reasoning',{tier:'complex',reason:'Several dependent decisions'}],['blocked',{answer:'No authorized interface is available.'}]])assert.equal(conversation.parse(wire.decode(JSON.stringify(grouped({status,...extra})))).status,status);
 const old={version:1,status:'completed',answer:'Existing saved result',claims:[{evidenceId:'old',path:'/count',value:2}]};assert.deepEqual(JSON.parse(wire.decode(JSON.stringify(old))),old);
});
test('invalid grouped values, substituted metadata and claim-count expansion never become a usable report',()=>{
 for(const bad of [{values:[{path:'/x',value:{json:'not JSON'}}]},{values:[{path:'/x',value:{json:'null'}}]},{values:[{path:'/x',value:{json:'{}',other:true}}]},{historical:'false',values:[]},{evidenceId:null,values:[]},{values:[{path:'/missing'}]},{values:Array.from({length:51},()=>({path:'/x',value:1}))}]){
  const p=grouped({status:'completed',answer:'Unverified',claims:[]});p.claims=[{evidenceId:'recorded',historical:false,values:[],...bad}];assert.throws(()=>wire.decode(JSON.stringify(p)),/INVALID_NATIVE_CLAIM_ENCODING/);
 }
});
