'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),review=require('../../src/imports/approval-review');
const base=()=>({status:'READY',approvalStatus:'AWAITING_APPROVAL',fieldMappings:{name:0,quantity:1},transformations:{},recordsValid:3,recordsInvalid:0,conflicts:[]});
test('approval review explains every required question without offering partial approval for tracked sources',()=>{
 const p=base();p.fieldMappings.serialTracked=2;p.recordsInvalid=2;
 const state=review.review(p,{missingAccountingSetup:true,missingLocationRows:true,trackingQuestion:{state:'needs_input',groups:[{mode:'serial',missingSkus:2}]}});
 assert.equal(state.canApprove,false);assert.deepEqual(state.blockers.map(r=>r.code),['accounting','location','tracking']);
 assert.match(state.blockers[2].detail,/2 serial-tracked SKUs/);assert(state.blockers.every(r=>r.href&&r.action));
 assert(review.planRequirements(p).some(r=>r.code==='rows'),'The canonical approval check still rejects the unresolved rows');
 assert.equal(review.review({...p,recordsValid:5,recordsInvalid:0}).canApprove,true);
});
test('workbook, images, ordinary rows and zero-ready previews all have actionable states',()=>{
 for(const p of [{...base(),sourceKind:'image'},{...base(),recordsValid:0},{...base(),recordsInvalid:1},{...base(),transformations:{workbook:{},allowPartialImport:true},recordsInvalid:1},{...base(),transformations:{sheetCount:2}}]){
  const state=review.review(p);assert.equal(state.canApprove,false);assert(state.blockers.length);assert(state.blockers.every(r=>r.href&&r.action&&r.detail));
 }
 assert.equal(review.review({...base(),recordsInvalid:1,transformations:{allowPartialImport:true}}).canApprove,true);
 assert.equal(review.review({...base(),sourceKind:'image',transformations:{imageReadingConfirmed:true}}).canApprove,true);
});
test('saved revisions, duplicate sources and expired previews never advertise approval',()=>{
 assert.deepEqual(review.review(base(),{previewRevision:{active:true}}).blockers.map(r=>r.code),['updating']);
 assert.equal(review.review(base(),{duplicatePlans:[{id:'completed'}]}).blockers[0].href,'/imports/completed');
 const expired=review.review({...base(),isExpired:true});assert.equal(expired.canApprove,false);assert.equal(expired.blockers[0].code,'expired');
 assert.equal(review.review({...base(),approvalStatus:'APPROVED'}).canApprove,false);
});
