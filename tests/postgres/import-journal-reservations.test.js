'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('reserved import journals avoid global posting locks while retaining exact replay, scope and closed-period checks',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,ledger=require('../../src/accounting/postgres-ledger'),imports=require('../../src/imports/postgres-service'),date=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const plan=await imports.analyse(db,ctx,{text:'Product,SKU\nReservation one,RES-J-1\nReservation two,RES-J-2\nReservation three,RES-J-3\nReservation four,RES-J-4',allowModel:false});await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const request={importId:plan.id,approvalHash:plan.integrityHash,count:4,postingDate:date},reserve=()=>db.transaction(c=>ledger.reserveImportNumbersInTransaction(c,ctx,request),{isolation:'READ COMMITTED'}),reservation=await reserve();
 assert.deepEqual(await reserve(),reservation,'Retry returns the same committed immutable range');
 await assert.rejects(db.transaction(c=>ledger.reserveImportNumbersInTransaction(c,ctx,{...request,count:3})),/different approved work/);
 await assert.rejects(db.query('UPDATE import_journal_reservations SET number_count=3 WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]),/cannot be changed/);
 const sourceHash=offset=>String(offset+1).repeat(64),header=offset=>({postingDate:date,sourceKey:`import:${plan.id}:batch:${sourceHash(offset)}:opening-value`,sourceType:'opening_inventory',sourceRecordType:'import_batch',sourceRecordId:plan.id,description:'Reserved import qualification',currency:'USD',metadata:{importId:plan.id,integrityHash:plan.integrityHash,sourceRowsHash:sourceHash(offset),importRows:1},lines:[{accountKey:'INVENTORY_ASSET',debitMinor:100,skuId:f.item.skuIds[0],locationId:f.location.id},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]}),token=(c,offset,actor=ctx)=>ledger.importNumberTokenInTransaction(c,actor,{importId:plan.id,approvalHash:plan.integrityHash,offset,sourceRowsHash:sourceHash(offset)}),post=offset=>db.transaction(async c=>ledger.postManyInTransaction(c,ctx,[header(offset)],{reservedImport:await token(c,offset)}),{isolation:'READ COMMITTED'});
 // Keep a real transaction holding both locks used by ordinary posting. The
 // reserved posts must commit before this blocker is released.
 const held={},ready=new Promise(r=>{held.ready=r;}),finish=new Promise(r=>{held.finish=r;});
 const blocker=db.transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['journal:'+ctx.workspaceId]);await c.query("UPDATE stockchief_runtime.business_number_counters SET last_number=last_number WHERE workspace_id=$1 AND kind='accounting_journal_entries' AND prefix='JE'",[ctx.workspaceId]);held.ready();await finish;},{isolation:'READ COMMITTED'});
 await ready;const posted=Promise.all([post(0),post(1)]);let timer;
 try{const results=await Promise.race([posted,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Reserved posting waited on the global journal counter or lock')),3000);})]);assert.deepEqual(results.map(r=>Number(r[0].entry.entry_number)),[Number(reservation.start_number),Number(reservation.start_number)+1]);}
 finally{clearTimeout(timer);held.finish();await blocker;await posted.catch(()=>{});}
 assert((await post(0))[0].replayed);
 const normal=await ledger.post(db,ctx,{postingDate:date,sourceKey:'normal-after-reservation',sourceType:'manual',currency:'USD',lines:[{accountKey:'CASH',debitMinor:10},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:10}]});assert.equal(Number(normal.entry.entry_number),Number(reservation.start_number)+4);
 await assert.rejects(db.transaction(async c=>ledger.postManyInTransaction(c,ctx,[header(2)],{reservedImport:{}})),/reservation is invalid/);
 await assert.rejects(db.transaction(async c=>ledger.postManyInTransaction(c,ctx,[{...header(2),sourceKey:'wrong-source'}],{reservedImport:await token(c,2)})),/does not match/);
 await assert.rejects(db.transaction(async c=>{await ledger.postManyInTransaction(c,ctx,[header(2)],{reservedImport:await token(c,2)});throw Error('Abort reserved batch');}),/Abort reserved batch/);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_key=$2',[ctx.workspaceId,header(2).sourceKey])).rows[0].n,0);
 await db.query("UPDATE accounting_periods SET status='CLOSED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,reservation.period_id]);await assert.rejects(post(2),/period.*closed/);
 await db.query("UPDATE accounting_periods SET status='OPEN' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,reservation.period_id]);assert.equal(Number((await post(2))[0].entry.entry_number),Number(reservation.start_number)+2);
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Foreign reservation',businessName:'Foreign books',email:randomUUID()+'@example.test',password:'Foreign-reservation!Aa7'});
 await assert.rejects(db.transaction(c=>token(c,3,{workspaceId:foreign.workspaceId,actorId:foreign.userId})),/outside its approved reservation/);
 await assert.rejects(db.transaction(c=>ledger.importNumberTokenInTransaction(c,ctx,{importId:plan.id,approvalHash:plan.integrityHash,offset:4,sourceRowsHash:sourceHash(3)})),/outside its approved reservation/);
 const balance=(await db.query('SELECT sum(debit_minor)::text debit,sum(credit_minor)::text credit FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(balance.debit,balance.credit);
});
