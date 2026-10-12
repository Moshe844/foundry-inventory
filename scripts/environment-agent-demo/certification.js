'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'data/environment-agent-demo');
function sourceHash(){const hash=createHash('sha256');
 const files=[];function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(/\.(js|sql|ejs)$/.test(entry.name))files.push(p);}}
 for(const dir of ['src','scripts/environment-agent-demo','tests/unit','tests/postgres','tests/helpers'])walk(path.join(root,dir));
 walk(path.join(root,'tests/fixtures/environment-agent-context-loss/legacy'));
 walk(path.join(root,'tests/fixtures/environment-agent-progress-loss/legacy'));
 files.push(path.join(root,'tests/fixtures/environment-agent-progress-loss/recorded.json'));
 files.push(path.join(root,'tests/fixtures/environment-agent-context-loss/recorded.json'));
 files.push(path.join(root,'package.json'),path.join(root,'package-lock.json'),path.join(root,'tests/fixtures/environment-agent-retest-failure.js'),
  path.join(root,'tests/fixtures/environment-agent-confirmation-failure.js'),path.join(root,'tests/fixtures/environment-agent-unfamiliar-screen.js'));
 for(const file of files.sort())hash.update(path.relative(root,file)).update(fs.readFileSync(file));return hash.digest('hex');
}
function requireCertificate(){const c=JSON.parse(fs.readFileSync(path.join(directory,'certification.json'),'utf8'));
 if(!c.passed||c.sourceHash!==sourceHash()||Date.now()-Date.parse(c.checkedAt)>86400000||c.skipped!==0)throw new Error('CURRENT_COMPLETE_CERTIFICATION_REQUIRED');return c;}
async function certify(){fs.mkdirSync(directory,{recursive:true});
 const image=JSON.parse(fs.readFileSync(path.join(directory,'sandbox-certificate.json'),'utf8')).image;
 const files=['tests/unit/environment-agent-progress-loss.test.js','tests/postgres/environment-agent-progress-loss.test.js',
  'tests/unit/environment-agent-context-lifecycle.test.js','tests/postgres/environment-agent-context-lifecycle.test.js',
  'tests/postgres/environment-agent-recorded-embedded.test.js',
  'tests/unit/environment-agent-embedded-certification.test.js','tests/postgres/environment-agent-embedded-certification.test.js',
  'tests/unit/environment-agent-live-inspection.test.js','tests/postgres/environment-agent-unfamiliar-screen.test.js',
  'tests/unit/environment-agent-openai-certification.test.js','tests/unit/environment-agent-openai-program-budget.test.js',
  'tests/postgres/environment-agent-openai-certification.test.js','tests/postgres/environment-agent-openai-surfaces.test.js',
  'tests/unit/environment-agent-fair-final.test.js','tests/unit/environment-agent-protocol-loop.test.js','tests/postgres/environment-agent-protocol-loop.test.js',
  'tests/postgres/environment-agent-retest.test.js','tests/unit/environment-agent-repairs.test.js','tests/postgres/environment-agent-repairs.test.js','tests/postgres/adaptive-goal-controller.test.js',
  'tests/unit/environment-agent-budget.test.js','tests/unit/environment-agent-checkpoint-approval.test.js','tests/unit/environment-agent-candidates.test.js','tests/unit/environment-agent-relay.test.js',
  'tests/unit/environment-agent-context.test.js','tests/unit/environment-agent-browser-recovery.test.js','tests/postgres/environment-agent-reliability.test.js',
  'tests/unit/environment-agent-native-sdk.test.js','tests/unit/environment-agent-sandbox.test.js','tests/unit/environment-agent-network.test.js','tests/unit/environment-agent-docker.test.js',
  'tests/unit/environment-agent-pilot-journal.test.js','tests/postgres/environment-agent-demo.test.js','tests/postgres/environment-agent-commercial.test.js',
  'tests/postgres/environment-agent-pilot.test.js','tests/postgres/environment-agent-checkpoint.test.js','tests/postgres/environment-agent-native-qualification.test.js',
  'tests/postgres/commercial-model-cost-budget.test.js','tests/postgres/autopilot-ui.test.js'];
 const start=sourceHash();const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['--test','--test-concurrency=2','--test-reporter=tap',...files],{cwd:root,windowsHide:true,
  env:{...process.env,STOCKCHIEF_DEMO_IMAGE:image},stdio:['ignore','pipe','pipe']});
 let out='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{out+=chunk;process.stdout.write(chunk);});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 fs.writeFileSync(path.join(directory,'certification-tests.tap'),out);
 const skipped=Number(out.match(/# skipped (\d+)/)?.[1]??-1);
 const certificate={passed:code===0&&skipped===0&&start===sourceHash(),exitCode:code,skipped,sourceHash:start,image,
  checkedAt:new Date().toISOString(),tests:Number(out.match(/# tests (\d+)/)?.[1]||0),paidCalls:0};
 fs.writeFileSync(path.join(directory,'certification.json'),JSON.stringify(certificate,null,2));
 if(!certificate.passed)throw new Error('Offline certification failed. Paid testing remains locked.');return certificate;
}
if(require.main===module)certify().then(c=>console.log(JSON.stringify(c))).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={sourceHash,requireCertificate,directory};
