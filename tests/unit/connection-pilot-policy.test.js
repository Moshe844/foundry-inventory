'use strict';const test=require('node:test'),assert=require('node:assert/strict'),policy=require('../../src/connections/launch-policy');
test('restored optional connections require a scoped staging grant and never enable production',t=>{
 const names=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));t.after(()=>{for(const[n,v]of Object.entries(saved))if(v===undefined)delete process.env[n];else process.env[n]=v;});
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES='allowed-workspace';process.env.STOCKCHIEF_STAGING_CONNECTION_PROVIDERS='shopify,clover,xero,quickbooks,microsoft365,erp_future';
 for(const provider of ['shopify','clover','xero','quickbooks','microsoft365']){assert.equal(policy.reason(provider,{workspaceId:'allowed-workspace'}),null);assert.throws(()=>policy.assertNewConnection(provider,{workspaceId:'other-workspace'}));assert.throws(()=>policy.assertNewConnection(provider));}
 assert.throws(()=>policy.assertNewConnection('erp_future',{workspaceId:'allowed-workspace'}));process.env.STOCKCHIEF_RUNTIME_ENV='production';assert.throws(()=>policy.assertNewConnection('xero',{workspaceId:'allowed-workspace'}));assert.equal(policy.metadata({type:'xero',available:true},{workspaceId:'allowed-workspace'}).available,false);
});

test('account pilot context is verified by storage and cannot be supplied or reused for another inventory',async t=>{
 const names=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));t.after(()=>{for(const[n,v]of Object.entries(saved))if(v===undefined)delete process.env[n];else process.env[n]=v;});
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES='approved-root';process.env.STOCKCHIEF_STAGING_CONNECTION_PROVIDERS='shopify';let reads=0;
 const db={async query(sql,args){reads++;assert.match(sql,/approved\.owner_account_id=target\.owner_account_id/);assert.match(sql,/target\.deletion_requested_at IS NULL AND approved\.deletion_requested_at IS NULL/);assert.deepEqual(args[1],['approved-root']);return {rows:args[0]==='sibling'?[{one:1}]:[]};}};
 const sibling=await policy.resolveWorkspaceContext(db,{workspaceId:'sibling'});assert.equal(policy.pilotAllowed('shopify',sibling),true);assert.equal(policy.pilotAllowed('xero',sibling),false);
 assert.equal(policy.pilotAllowed('shopify',{workspaceId:'sibling',ownerAccountId:'approved-root',pilotAllowed:true}),false);
 assert.equal(policy.pilotAllowed('shopify',await policy.resolveWorkspaceContext(db,{workspaceId:'unrelated',...{ownerAccountId:'approved-root',pilotAllowed:true}})),false);
 assert.equal(policy.pilotAllowed('shopify',{...sibling,workspaceId:'unrelated'}),false);
 await policy.assertWorkspaceConnection(db,'shopify',{workspaceId:'sibling'});await assert.rejects(policy.assertWorkspaceConnection(db,'shopify',{workspaceId:'unrelated'}));
 process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES='revoked-root';assert.equal(policy.pilotAllowed('shopify',sibling),false);
 process.env.STOCKCHIEF_RUNTIME_ENV='production';const before=reads;assert.equal(await policy.resolveWorkspaceContext(db,sibling),sibling);assert.equal(reads,before);assert.equal(policy.pilotAllowed('shopify',sibling),false);
});
