'use strict';

// Hosted, disposable provider qualification. Never import a production profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const forbidden=['DATABASE_URL','FOUNDRY_DATABASE_URL','STOCKCHIEF_BILLING_STRIPE_SECRET_KEY',
 'STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STOCKCHIEF_SANDBOX_STRIPE_KEY'];
function main(){
 assert.equal(process.env.CI,'true','Run provider qualification on a hosted CI runner');
 assert.equal(process.env.NODE_ENV,'test');
 assert.notEqual(process.env.STOCKCHIEF_RUNTIME_ENV,'production');
 for(const key of forbidden)assert(!process.env[key],'Unexpected existing credential/configuration: '+key);
 const cli=process.env.STOCKCHIEF_STRIPE_CLI;
 assert(cli&&path.isAbsolute(cli)&&fs.existsSync(cli),'Provide the checksum-verified Stripe CLI');
 assert(process.env.RUNNER_TEMP&&path.isAbsolute(process.env.RUNNER_TEMP),'Expected isolated runner storage');
 const email=process.env.STOCKCHIEF_SANDBOX_EMAIL;
 assert(/^[^\s@]+@stockchiefhq\.com$/.test(email||''),'Expected the StockChief sandbox contact');
 const config=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'stockchief-stripe-config-'));
 const env={...process.env,XDG_CONFIG_HOME:config,STRIPE_NO_AUTO_UPDATE:'1'};
 const created=spawnSync(cli,['sandbox','create','--email',email,'--non-interactive'],
  {cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024,windowsHide:true});
 const redact=value=>String(value||'').replace(/(?:rkcs|sk|rk|pk|whsec)_(?:test_|live_)?[A-Za-z0-9_-]+/g,'[private key]')
  .replace(/https:\/\/dashboard\.stripe\.com\/onboard_sandbox\/\S+/g,'[private sandbox claim URL]');
 if(created.error||created.status!==0){
  console.error(redact(created.stderr||created.stdout).slice(-3000));
  throw Error('Temporary Stripe sandbox creation failed; no production fallback is allowed');
 }
 const output=created.stdout||'',first=output.indexOf('{'),last=output.lastIndexOf('}');
 assert(first>=0&&last>first,'Stripe CLI did not return sandbox metadata');
 let sandbox;try{sandbox=JSON.parse(output.slice(first,last+1));}catch{throw Error('Stripe CLI returned invalid sandbox metadata');}
 assert(/^(rkcs|sk|rk)_test_[A-Za-z0-9]+$/.test(sandbox.secret_key||''),'Only a newly created test key is accepted');
 assert(/^acct_[A-Za-z0-9]+$/.test(sandbox.account_id||''),'Missing sandbox account identity');
 // Register masks before running application code. The CLI output/profile is
 // never written to artifacts, repository files, or job output.
 for(const value of [sandbox.secret_key,sandbox.publishable_key,sandbox.claim_url].filter(Boolean))console.log('::add-mask::'+value);
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const applicationTree=execFileSync('git',['rev-parse','HEAD:src'],{cwd:root,encoding:'utf8'}).trim();
 console.log('STRIPE_SANDBOX_CREATED '+JSON.stringify({accountId:sandbox.account_id,expiresAt:sandbox.expires_at,commit,applicationTree,liveTransactions:0}));
 const run=spawnSync(process.execPath,['scripts/certify-stripe-merchant-sandbox.js'],{cwd:root,
  env:{...env,STOCKCHIEF_RUNTIME_ENV:'test',FOUNDRY_SKIP_LOCAL_ENV:'1',STOCKCHIEF_CERTIFY_STRIPE_SANDBOX:'1',STOCKCHIEF_SANDBOX_STRIPE_KEY:sandbox.secret_key},
  encoding:'utf8',timeout:10*60*1000,maxBuffer:20*1024*1024,windowsHide:true});
 const clean=value=>redact(value).split(sandbox.secret_key).join('[private key]');
 if(run.stdout)process.stdout.write(clean(run.stdout));
 if(run.stderr)process.stderr.write(clean(run.stderr));
 if(run.error||run.status!==0)throw Error('Stripe sandbox financial qualification failed');
 const proof=JSON.parse(fs.readFileSync(path.join(root,'output/stripe-sandbox-financial-proof.json'),'utf8'));
 assert.equal(proof.sandboxAccountId,sandbox.account_id);
 assert.equal(proof.liveTransactions,0);
 assert.deepEqual(proof.plans.map(p=>p.plan),['starter','growth','pro']);
 const result={...proof,commit,applicationTree,temporarySandbox:true,expiresAt:sandbox.expires_at,
  productionCredentialsPresent:false,productionDatabaseAccessed:false};
 fs.writeFileSync(path.join(root,'output/stripe-sandbox-financial-proof.json'),JSON.stringify(result,null,2));
 console.log('STRIPE_HOSTED_SANDBOX_VERIFIED '+JSON.stringify({commit,applicationTree,plans:proof.plans.map(p=>p.plan),liveTransactions:0}));
}
try{main();}catch(error){console.error('STRIPE_HOSTED_SANDBOX_FAILED '+error.message);process.exitCode=1;}
