'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const candidates=require('../../scripts/environment-agent-demo/candidates');
test('all three candidate adapters refuse to initialize while spending is locked',async()=>{
  for(const candidate of ['openai','claude','adaptive'])await assert.rejects(()=>candidates[candidate]({
    budget:{status:()=>({ceiling:0})}}),/PAID_TESTING_LOCKED/);
});
test('shared discovery, browser and sandbox tools do not expose approval, SQL or host execution',async()=>{
  const tools=candidates.sharedTools({browser:{act:async input=>input},gateway:{interfaces:async()=>({}),
    dataset:async input=>input,operate:async input=>input},sandbox:{exec:async input=>input}});
  assert.deepEqual(tools.map(t=>t.name),['environment_notebook','environment_browser','environment_evidence','environment_interfaces','environment_dataset','business_operations','workspace_exec','workspace_read']);
  const exec=await tools.find(t=>t.name==='workspace_exec').execute({command:'pwd'});
  assert.equal(exec.runAs,'node');assert.equal(exec.workdir,'/workspace');
  assert.equal(exec.login,false);
  for(const tool of tools)assert.ok(tool.schema);
});
test('official native SDK interfaces load offline at the pinned versions',async()=>{
  const {SandboxAgent,compaction}=require('@openai/agents/sandbox');
  const {tool}=require('@openai/agents');
  const sdk=await import('@anthropic-ai/claude-agent-sdk');
  const tools=candidates.sharedTools({});
  const agent=new SandboxAgent({name:'Offline compatibility test',model:candidates.CANDIDATES.openai.model,
    capabilities:[compaction()],tools:tools.map(t=>tool({name:t.name,description:t.description,parameters:t.schema,execute:async()=>''}))});
  assert.equal(agent.tools.length,8);
  const server=sdk.createSdkMcpServer({name:'offline-test',tools:tools.map(t=>sdk.tool(t.name,t.description,t.schema.shape,
    async()=>({content:[{type:'text',text:'offline'}]})))});
  assert.equal(server.type,'sdk');
});
