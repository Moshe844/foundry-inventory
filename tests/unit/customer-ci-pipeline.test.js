'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
test('the actual required CI logging pipeline propagates a failing test command',()=>{
 const workflow=fs.readFileSync(path.resolve(__dirname,'../../.github/workflows/customer-navigation.yml'),'utf8');
 const blocks=[...workflow.matchAll(/      - run: \|\r?\n((?:          [^\n]*\r?\n)+)/g)].map(m=>m[1].replace(/^          /gm,''));
 const block=blocks.find(s=>s.includes('npm run test:customer-navigation'));assert(block,'Required customer test step exists');
 const command=block.replace('npm run test:customer-navigation','(exit 19)');assert.notEqual(command,block);
 const shell=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'/bin/bash';
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-ci-pipeline-'));
 try{const result=cp.spawnSync(shell,['-c',command],{cwd:directory,encoding:'utf8',windowsHide:true});assert.ifError(result.error);assert.equal(result.status,19,'A test failure must fail the build even when tee succeeds');}
 finally{assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(directory).startsWith('stockchief-ci-pipeline-'));fs.rmSync(directory,{recursive:true,force:true});}
});
