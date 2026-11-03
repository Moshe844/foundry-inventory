'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{specification}=require('../../src/operations/postgres-staging-qualification');
test('hosted qualification cannot select production, arbitrary commands, another release or more resources',()=>{
 const release='a'.repeat(40),env={RENDER_SERVICE_ID:'srv-daqh418473hc73853e7g',RENDER_GIT_COMMIT:release,DATABASE_URL:'postgres://fixture@dpg-damlkhuk1f9s739h5ga0-a/stockchief_staging'},job={id:'synthetic-job',workspaceId:'wsp_synthetic',kind:'qualification.staging-load',payload:{release}};
 const load=specification(job,env);assert(load.args.includes('--hosted-sessions'));assert.equal(load.timeout,180000);assert(load.args.includes('120'));
 const tenants=[{workspaceId:'wsp_synthetic',users:25},{workspaceId:'wsp_growth',users:10},{workspaceId:'wsp_starter',users:3},{workspaceId:'wsp_otherpro',users:12}];assert(specification({...job,payload:{release,tenants}},env).args.includes('--qa-workspaces'));
 for(const invalid of [tenants.slice(0,3),[...tenants,{workspaceId:'wsp_extra',users:1}],tenants.map(t=>({...t,users:50})),[{workspaceId:'wsp_elsewhere',users:25},{workspaceId:'wsp_other',users:25}]])assert.throws(()=>specification({...job,payload:{release,tenants:invalid}},env));
 for(const wrong of [{...env,RENDER_SERVICE_ID:'production'},{...env,DATABASE_URL:'postgres://fixture@production/stockchief'},{...env,RENDER_GIT_COMMIT:'b'.repeat(40)}])assert.throws(()=>specification(job,wrong));
 assert.throws(()=>specification(job,{...env,DATABASE_URL:'postgres://fixture@dpg-damlkhuk1f9s739h5ga0-a.attacker.test/stockchief_staging'}));
 assert.throws(()=>specification({...job,kind:'arbitrary.command'},env));assert.throws(()=>specification({...job,workspaceId:'../../private'},env));
 const million={...job,kind:'qualification.staging-million',payload:{release,mode:'million',run:'synthetic-run'}};assert(specification(million,env).args.includes('--max-old-space-size=1280'));
 for(const payload of [{...million.payload,run:'../../private'},{...million.payload,mode:'execute'},{...million.payload,release:'$(secret)'}])assert.throws(()=>specification({...million,payload},env));
});
