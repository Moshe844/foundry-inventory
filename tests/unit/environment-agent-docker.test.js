'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSandbox}=require('../../scripts/environment-agent-demo/sandbox');
test('actual Docker isolation, bounded command, scratch resume and removed-container fail-closed',
 {skip:!process.env.STOCKCHIEF_DEMO_IMAGE,timeout:60000},async()=>{
 const image=process.env.STOCKCHIEF_DEMO_IMAGE;const sandbox=await createSandbox({image});let removed=false;
 try{
  assert.equal((await sandbox.certify()).passed,true);
  assert.equal((await sandbox.exec({cmd:'printf evidence > note.txt; ln -s /etc/passwd forbidden'})).exitCode,0);
  const resumed=await createSandbox({image,containerId:sandbox.state.containerId});
  assert.equal((await resumed.readFile({path:'/workspace/note.txt'})).toString(),'evidence');
  await assert.rejects(()=>resumed.readFile({path:'/workspace/forbidden'}),/outside workspace/);
  assert.notEqual((await sandbox.exec({cmd:'sleep 30'})).exitCode,0);
  await sandbox.close();removed=true;
  await assert.rejects(()=>createSandbox({image,containerId:sandbox.state.containerId}));
 }finally{if(!removed)await sandbox.close();}
});
