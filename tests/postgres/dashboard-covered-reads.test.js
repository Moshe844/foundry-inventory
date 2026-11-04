'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('Money and stock-value previews support covered reads while retaining exact balances',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/dashboard-covered-read-checks').check(f.db,f.ctx)));
});
test('covered financial reads remain exact while an older snapshot requires visibility rechecks',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 let ready,release;const started=new Promise(r=>ready=r),unblock=new Promise(r=>release=r);let initial;
 const older=db.transaction(async c=>{initial=Number((await c.query('SELECT count(*) n FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);ready();await unblock;return Number((await c.query('SELECT count(*) n FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);},{isolation:'REPEATABLE READ',readOnly:true});
 try{await Promise.race([started,older]);await require('../../src/accounting/postgres-ledger').post(db,ctx,{sourceKey:'covered-later-sale',currency:'USD',lines:[{accountKey:'CASH',debitMinor:17},{accountKey:'SALES_REVENUE',creditMinor:17}]});
  const current=await require('../helpers/dashboard-covered-read-checks').check(db,ctx);assert(current.plans.find(p=>p.kind==='money').heapFetches>0,'The held older snapshot requires visibility rechecks for the newly committed rows');
  assert.equal((await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{})).revenueMinor,17);
 }finally{release();assert.equal(await older,initial,'An older snapshot retains its own committed view');}
 const settled=await require('../helpers/dashboard-covered-read-checks').check(db,ctx);assert(settled.plans.every(p=>p.heapFetches===0),'After the older snapshot ends and vacuum completes, the same queries need no source-row fetches');
});
