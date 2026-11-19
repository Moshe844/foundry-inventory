'use strict';

// Hosted, disposable provider qualification. Never import a production profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const forbidden=['DATABASE_URL','FOUNDRY_DATABASE_URL','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY',
 'STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STOCKCHIEF_SANDBOX_STRIPE_KEY'];
function assertTestKey(key){assert(/^(rkcs|sk|rk)_test_[A-Za-z0-9_-]+$/.test(key||''),'Only a sandbox test key is accepted');}
function assertSafeEnvironment(env){
 assert.equal(env.CI,'true','Run provider qualification on a hosted CI runner');
 assert.equal(env.NODE_ENV,'test');
 assert.notEqual(env.STOCKCHIEF_RUNTIME_ENV,'production');
 for(const key of forbidden)assert(!env[key],'Unexpected existing credential/configuration: '+key);
 if(env.STOCKCHIEF_CERTIFICATION_STRIPE_KEY)assertTestKey(env.STOCKCHIEF_CERTIFICATION_STRIPE_KEY);
}
function redactPrivate(value,privateValues=[]){
 let clean=String(value||'').replace(/(?:rkcs|sk|rk|pk|whsec)_(?:test_|live_)?[A-Za-z0-9_-]+/g,'[private key]')
  .replace(/https:\/\/dashboard\.stripe\.com\/onboard_sandbox\/\S+/g,'[private sandbox claim URL]');
 for(const secret of privateValues.filter(Boolean))clean=clean.split(secret).join('[private value]');
 return clean;
}
function assertPrivateProof(text,privateValues){for(const value of privateValues.filter(Boolean))assert(!text.includes(value),'Private sandbox material must not appear in proof artifacts');}
function assertCredentialsConfigured(env){assert(env.STOCKCHIEF_CERTIFICATION_STRIPE_KEY||env.STOCKCHIEF_CREATE_TEMPORARY_SANDBOX==='1','Save the STOCKCHIEF_CERTIFICATION_STRIPE_KEY sandbox secret before running provider tests; temporary provisioning requires an explicit opt-in');}
function main(){
 assertSafeEnvironment(process.env);
 assertCredentialsConfigured(process.env);
 const cli=process.env.STOCKCHIEF_STRIPE_CLI;
 assert(cli&&path.isAbsolute(cli)&&fs.existsSync(cli),'Provide the checksum-verified Stripe CLI');
 assert(process.env.RUNNER_TEMP&&path.isAbsolute(process.env.RUNNER_TEMP),'Expected isolated runner storage');
 const email=process.env.STOCKCHIEF_SANDBOX_EMAIL;
 assert(/^[^\s@]+@stockchiefhq\.com$/.test(email||''),'Expected the StockChief sandbox contact');
 const config=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'stockchief-stripe-config-'));
 const env={...process.env,XDG_CONFIG_HOME:config,STRIPE_NO_AUTO_UPDATE:'1'};
 let sandbox,temporarySandbox=false;
 if(process.env.STOCKCHIEF_CERTIFICATION_STRIPE_KEY){
  sandbox={secret_key:process.env.STOCKCHIEF_CERTIFICATION_STRIPE_KEY};
 }else{
  const created=spawnSync(cli,['sandbox','create','--email',email,'--non-interactive'],
   {cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,windowsHide:true});
  if(created.error||created.status!==0){
   console.error('STRIPE_SANDBOX_SETUP_FAILED '+JSON.stringify({exitCode:created.status,signal:created.signal,error:created.error?.code}));
   throw Error('Temporary Stripe sandbox creation failed; no production fallback is allowed');
  }
  const output=created.stdout||'',first=output.indexOf('{'),last=output.lastIndexOf('}');
  assert(first>=0&&last>first,'Stripe CLI did not return sandbox metadata');
  try{sandbox=JSON.parse(output.slice(first,last+1));}catch{throw Error('Stripe CLI returned invalid sandbox metadata');}
  if(sandbox.browser_url||sandbox.verification_code)throw Error('Anonymous sandbox creation requested browser login. Configure the encrypted sandbox test-key secret; no login or live fallback is allowed.');
  assert(/^acct_[A-Za-z0-9]+$/.test(sandbox.account_id||''),'Missing sandbox account identity');
  temporarySandbox=true;
 }
 assertTestKey(sandbox.secret_key);
 // Never print credentials, even as CI mask commands: tee would otherwise
 // retain their literal values in the downloadable log artifact. Configured
 // GitHub secrets are additionally masked by the runner itself.
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const applicationTree=execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim();
 console.log('STRIPE_SANDBOX_READY '+JSON.stringify({accountId:sandbox.account_id,expiresAt:sandbox.expires_at,temporarySandbox,commit,applicationTree,liveTransactions:0}));
 const run=spawnSync(process.execPath,['scripts/certify-stripe-merchant-sandbox.js'],{cwd:root,
  env:{...env,STOCKCHIEF_RUNTIME_ENV:'test',FOUNDRY_SKIP_LOCAL_ENV:'1',STOCKCHIEF_CERTIFY_STRIPE_SANDBOX:'1',STOCKCHIEF_SANDBOX_STRIPE_KEY:sandbox.secret_key},
  encoding:'utf8',timeout:10*60*1000,maxBuffer:20*1024*1024,windowsHide:true});
 const privateValues=[sandbox.secret_key,sandbox.publishable_key,sandbox.claim_url];
 const clean=value=>redactPrivate(value,privateValues);
 if(run.stdout)process.stdout.write(clean(run.stdout));
 if(run.stderr)process.stderr.write(clean(run.stderr));
 if(run.error||run.status!==0)throw Error('Stripe sandbox financial qualification failed');
 const proofText=fs.readFileSync(path.join(root,'output/stripe-sandbox-financial-proof.json'),'utf8');
 assertPrivateProof(proofText,privateValues);
 const proof=JSON.parse(proofText);
 assert(/^acct_[A-Za-z0-9]+$/.test(proof.sandboxAccountId));
 if(temporarySandbox)assert.equal(proof.sandboxAccountId,sandbox.account_id);
 assert.equal(proof.liveTransactions,0);
 assert.deepEqual(proof.plans.map(p=>p.plan),['starter','growth','pro']);
 const result={...proof,commit,applicationTree,temporarySandbox,expiresAt:sandbox.expires_at,
  credentialSource:temporarySandbox?'official CLI anonymous sandbox':'encrypted GitHub sandbox test-key secret',
  productionCredentialsPresent:false,productionDatabaseAccessed:false};
 fs.writeFileSync(path.join(root,'output/stripe-sandbox-financial-proof.json'),JSON.stringify(result,null,2));
 console.log('STRIPE_HOSTED_SANDBOX_VERIFIED '+JSON.stringify({commit,applicationTree,plans:proof.plans.map(p=>p.plan),liveTransactions:0}));
}
module.exports={assertTestKey,assertSafeEnvironment,assertCredentialsConfigured,redactPrivate,assertPrivateProof};
if(require.main===module)try{main();}catch(error){console.error('STRIPE_HOSTED_SANDBOX_FAILED '+error.message);process.exitCode=1;}
