'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ledger=require('../../src/accounting/postgres-ledger'),{newId,nowIso}=require('../../src/lib/util');

test('journal numbers survive concurrent batches, rollback, legacy writers, backfill and tenant boundaries',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const input=key=>({postingDate:today,sourceKey:key,sourceType:'manual',description:'Number allocation qualification',currency:'USD',lines:[{accountKey:'CASH',debitMinor:100},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]});
 const current=async workspaceId=>Number((await db.query("SELECT last_number FROM stockchief_runtime.business_number_counters WHERE workspace_id=$1 AND kind='accounting_journal_entries' AND prefix='JE'",[workspaceId||ctx.workspaceId])).rows[0]?.last_number||0);
 const initial=await current();
 const observed={...db,transaction:(fn,settings={})=>db.transaction(c=>fn({query:(sql,args)=>{assert(!/MAX\s*\(\s*entry_number/i.test(sql),'Runtime allocation must not scan journal history');return c.query(sql,args);}}),{...settings,isolation:'READ COMMITTED',retrySafe:true})};
 const concurrent=await Promise.all(Array.from({length:20},(_,n)=>ledger.post(observed,ctx,input('number-concurrent-'+n))));
 assert.deepEqual(concurrent.map(r=>Number(r.entry.entry_number)).sort((a,b)=>a-b),Array.from({length:20},(_,n)=>initial+n+1));assert.equal(await current(),initial+20);
 const repeated=input('number-replay'),replays=await Promise.all([ledger.post(observed,ctx,repeated),ledger.post(observed,ctx,repeated)]);assert.equal(replays[0].entry.id,replays[1].entry.id);assert.equal(await current(),initial+21);
 const batch=await observed.transaction(c=>ledger.postManyInTransaction(c,ctx,[input('number-batch-a'),input('number-batch-a'),input('number-batch-b')]));
 assert.deepEqual(batch.map(r=>Number(r.entry.entry_number)),[initial+22,initial+22,initial+23]);assert.equal(await current(),initial+23);
 await assert.rejects(db.transaction(async c=>{await ledger.postInTransaction(c,ctx,input('number-aborted'));throw Error('Abort numbered entry');}),/Abort numbered entry/);
 assert.equal(await current(),initial+23);assert.equal((await db.query("SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_key='number-aborted'",[ctx.workspaceId])).rows[0].n,0);

 // A preceding deployed writer assigns its own number and inserts a normal
 // balanced journal. Its insert must advance the same counter during rollout.
 const template=concurrent[0].entry.id,legacyId=newId('je');
 await db.transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['journal:'+ctx.workspaceId]);
  const number=initial+100;
  await c.query(`INSERT INTO accounting_journal_entries(id,workspace_id,entry_number,posting_date,period_id,description,status,source_type,source_key,created_by_type,created_by_user_id,engine_version,metadata,created_at,posted_at)
   SELECT $1,workspace_id,$2,posting_date,period_id,'Legacy writer qualification','POSTED','manual','number-legacy','USER',$3,'legacy-test','{}',$4,$4
   FROM accounting_journal_entries WHERE workspace_id=$5 AND id=$6`,[legacyId,number,ctx.actorId,nowIso(),ctx.workspaceId,template]);
  const lines=(await c.query('SELECT * FROM accounting_journal_lines WHERE workspace_id=$1 AND entry_id=$2 ORDER BY line_number',[ctx.workspaceId,template])).rows;
  for(const line of lines)await c.query(`INSERT INTO accounting_journal_lines(id,workspace_id,entry_id,line_number,account_id,debit_minor,credit_minor,currency,metadata,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9)`,[newId('jel'),ctx.workspaceId,legacyId,line.line_number,line.account_id,line.debit_minor,line.credit_minor,line.currency,nowIso()]);
 },{isolation:'READ COMMITTED'});
 assert.equal(await current(),initial+100);assert.equal(Number((await ledger.post(observed,ctx,input('number-after-legacy'))).entry.entry_number),initial+101);

 // Rehearse installation against existing posted journals in this disposable
 // fixture. No posted entry or line is edited or removed by the backfill.
 const before=(await db.query('SELECT count(*)::int n,sum(entry_number)::text numbers FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 await db.transaction(async c=>{
  await c.query('DROP TRIGGER capture_journal_number ON accounting_journal_entries;DROP FUNCTION stockchief_capture_journal_number()');
  await c.query("DELETE FROM stockchief_runtime.business_number_counters WHERE workspace_id=$1 AND kind='accounting_journal_entries' AND prefix='JE'",[ctx.workspaceId]);
  await c.query(fs.readFileSync(path.join(__dirname,'../../src/db/postgres-migrations/231-atomic-journal-numbers.sql'),'utf8'));
 },{isolation:'READ COMMITTED'});
 assert.equal(await current(),initial+101);assert.deepEqual((await db.query('SELECT count(*)::int n,sum(entry_number)::text numbers FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0],before);
 assert.equal(Number((await ledger.post(observed,ctx,input('number-after-backfill'))).entry.entry_number),initial+102);

 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other books',businessName:'Other number qualification',email:'other-journal-number@example.test',password:'Other-number-qualification!Aa7'}),foreign={workspaceId:other.workspaceId,actorId:other.userId};
 await ledger.configure(db,foreign,{startDate:'2026-01-01',currency:'USD'});
 assert.equal(Number((await ledger.post(observed,foreign,input('number-after-backfill'))).entry.entry_number),1);assert.equal(await current(foreign.workspaceId),1);assert.equal(await current(),initial+102);
 await assert.rejects(db.transaction(async c=>{
  await c.query("UPDATE stockchief_runtime.business_number_counters SET last_number=9007199254740991 WHERE workspace_id=$1 AND kind='accounting_journal_entries' AND prefix='JE'",[ctx.workspaceId]);
  await ledger.postInTransaction(c,ctx,input('number-range-exhausted'));
 }),/Journal numbering has reached its supported range/);
 assert.equal(await current(),initial+102);
 const balanced=(await db.query('SELECT sum(debit_minor)::text debit,sum(credit_minor)::text credit FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(balanced.debit,balanced.credit);
});
