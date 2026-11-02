'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
test('the actual required CI logging pipeline propagates a failing test command',()=>{
 const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/customer-navigation.yml'),'utf8');
 const blocks=[...workflow.matchAll(/      - (?:name: [^\r\n]+\r?\n        )?run: \|\r?\n((?:          [^\n]*\r?\n)+)/g)].map(m=>m[1].replace(/^          /gm,''));
 const required=blocks.filter(s=>s.includes('npm run test:customer-navigation'));assert.equal(required.length,2,'Core and complete click crawl remain separate required steps');
 const shell=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'/bin/bash';
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-ci-pipeline-'));
 try{for(const block of required){const command=block.replace(/npm run test:customer-navigation:[a-z]+/,'(exit 19)');assert.notEqual(command,block);const result=cp.spawnSync(shell,['-c',command],{cwd:directory,encoding:'utf8',windowsHide:true});assert.ifError(result.error);assert.equal(result.status,19,'A test failure must fail the build even when tee succeeds');}}
 finally{assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(directory).startsWith('stockchief-ci-pipeline-'));fs.rmSync(directory,{recursive:true,force:true});}
});
test('the inventory regression pipeline retains every piped verdict and its final failure',()=>{
 const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/inventory-capacity.yml'),'utf8');
 // Node force-exit can discard child-to-parent verdicts on nonblocking pipes.
 // Do not allow a green build with an incomplete test inventory (nodejs/node#64833).
 assert.doesNotMatch(workflow,/node [^\r\n]*--test-force-exit/);
 const commands=workflow.split(/\r?\n/).filter(line=>line.trimStart().startsWith('node --test '));
 assert(commands.length>0);assert(commands.every(line=>line.startsWith('          node ')),'Every test command belongs to its YAML run block');
 const blocks=[...workflow.matchAll(/      - (?:name: [^\r\n]+\r?\n        )?run: \|\r?\n((?:          [^\n]*\r?\n)+)/g)].map(m=>m[1].replace(/^          /gm,''));
 const block=blocks.find(s=>s.includes('tee output/inventory-ci/full-regressions.log'));
 assert(block,'The full unit/integration gate remains required');
 const shell=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'/bin/bash';
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-ci-verdicts-'));
 try{
  fs.mkdirSync(path.join(directory,'output/inventory-ci'),{recursive:true});
  fs.writeFileSync(path.join(directory,'verdicts.test.cjs'),"const test=require('node:test');for(let n=0;n<1000;n++)test('verdict '+n+' '+ 'x'.repeat(256),()=>{});test('final verdict',()=>{if(process.env.FAIL_LAST==='1')throw Error('last verdict must fail the build');});");
  let command=block.replace('tests/unit/*.test.js tests/integration/*.test.js','verdicts.test.cjs');assert.notEqual(command,block);
  const executable="'"+process.execPath.replaceAll('\\','/').replaceAll("'","'\\''")+"'";
  command=command.replace(/^node /m,executable+' --test-reporter=tap ');
  const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
  for(const fail of [false,true]){
   const result=cp.spawnSync(shell,['-c',command],{cwd:directory,env:{...childEnv,FAIL_LAST:fail?'1':'0'},encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:8*1024*1024});
   assert.ifError(result.error);assert.equal(result.status,fail?1:0,'The final verdict determines pipeline success');
   const log=fs.readFileSync(path.join(directory,'output/inventory-ci/full-regressions.log'),'utf8');
   assert.match(log,/# tests 1001\b/);assert.match(log,/# pass /);assert.match(log,new RegExp('# fail '+(fail?1:0)+'\\b'));
   assert.match(log,/final verdict/);if(fail)assert.match(log,/last verdict must fail the build/);
  }
 }finally{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert(path.basename(directory).startsWith('stockchief-ci-verdicts-'));fs.rmSync(directory,{recursive:true,force:true});}
});
