'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('mixed lot imports share bounded balanced journals with exact source, movement and batch traceability',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('mixed-journal-capacity',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const text=['Product,SKU,Quantity,Location,Cost,Lot,Lot Tracked,Serial Tracked,Expiry date',...Array.from({length:5001},(_,n)=>['Mixed item '+n,'MIX-JOURNAL-'+n,2,'Dispatch','1.25',n%4===1?'FOOD-'+n:'',n%4===1?'Yes':'No','No',n%4===1?'2027-12-31':''].join(','))].join('\n');
 const plan=await imports.analyse(db,ctx,{text,filename:'mixed-journal.csv',allowModel:false});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.rowsImported,5001);
 const evidence=(await db.query(`SELECT count(*)::int rows,count(DISTINCT e.id)::int journals,count(*) FILTER(WHERE m.lot_id IS NOT NULL)::int lot_rows,sum(l.debit_minor)::text value
  FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id JOIN movements m ON m.workspace_id=l.workspace_id AND m.id=l.metadata::jsonb->>'movementId'
  WHERE e.workspace_id=$1 AND e.source_record_type='import_batch' AND e.source_record_id=$2 AND l.metadata::jsonb ? 'importRowId'`,[ctx.workspaceId,plan.id])).rows[0];
 assert.deepEqual(evidence,{rows:5001,journals:3,lot_rows:1250,value:'1250250'});
 assert.equal((await db.query(`SELECT count(*)::int n FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id JOIN lots lot ON lot.workspace_id=l.workspace_id AND lot.code=l.metadata::jsonb->>'lotCode' JOIN movements m ON m.workspace_id=l.workspace_id AND m.id=l.metadata::jsonb->>'movementId' AND m.lot_id=lot.id WHERE e.workspace_id=$1 AND e.source_record_id=$2`,[ctx.workspaceId,plan.id])).rows[0].n,1250);
 const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId);assert.equal(pnl.netIncomeMinor,0);assert((await imports.execute(db,ctx,plan.id)).duplicate);
});
