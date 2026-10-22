'use strict';const test=require('node:test'),assert=require('node:assert/strict'),review=require('../../src/imports/tracking-review');
test('tracking summaries conserve SKU requirements across locations and invalidate with source/version changes',async()=>{
 const plan={workspaceId:'tenant-a',sourceHash:'source-a',planVersion:2,fieldMappings:{serialTracked:0,lotTracked:1},transformations:{}},tracker=review.tracker(plan.fieldMappings);
 const row=(code,serial,lot,problems)=>({id:code,raw:[serial,lot],parsed:{code},problems:problems.map(code=>({code}))});
 tracker.add([row('A','Yes','No',['missing_serial','serial_quantity']),row('B','No','Yes',['missing_lot'])]);tracker.add([row('A','Yes','No',['missing_serial'])]);plan.transformations.trackingSummary=tracker.finish(plan);
 assert.equal(review.savedSummary(plan).missingLocationRows,0);const untracked=review.tracker({});untracked.add([row('Z','No','No',['no_location'])]);assert.equal(untracked.finish(plan).missingLocationRows,1);
 let queries=0;const db={query:async()=>{queries++;return{rows:[{serial_skus:1,lot_skus:1,missing_serial_skus:1,missing_lot_skus:1}]};}};
 assert.equal((await review.read(db,'tenant-a',plan)).groups[0].sourceSkus,1);assert.equal(queries,0);
 await review.read(db,'tenant-a',{...plan,planVersion:3});await review.read(db,'tenant-a',{...plan,sourceHash:'changed'});assert.equal(queries,2,'Stale derived data must be discarded');
 await assert.rejects(review.read(db,'tenant-b',plan),/could not be found/);assert.equal(queries,2,'A cached preview never bypasses tenant identity');
});
test('excluded document evidence and skipped rows never create stock or tracking questions',()=>{
 const plan={sourceHash:'fresh',planVersion:4},summary=review.tracker({serialTracked:0,lotTracked:1}),row=status=>({status,id:status,raw:['Yes','Yes'],parsed:{code:status},problems:[{code:'no_location'},{code:'missing_serial'},{code:'missing_lot'}]});
 summary.add([row('EXCLUDED'),row('SKIPPED')]);const result=summary.finish(plan);assert.equal(result.missingLocationRows,0);assert.equal(result.serial_skus,0);assert.equal(result.lot_skus,0);assert.equal(result.missing_serial_skus,0);assert.equal(result.missing_lot_skus,0);assert.equal(review.savedSummary({...plan,transformations:{trackingSummary:{...result,version:1}}}),null,'Old summaries which counted excluded rows must be recomputed');
});
