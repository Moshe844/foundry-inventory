'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {approvalChange}=require('../../src/web/public/adaptive-goal');
test('a new pending card is delivered even while the goal stays WAITING_APPROVAL',()=>{
 assert.deepEqual(approvalChange(['already-approved'],['next-pending']),{removed:['already-approved'],added:['next-pending']});
 assert.deepEqual(approvalChange([],['first-pending']),{removed:[],added:['first-pending']});
});
test('unchanged cards do not cause reload loops and completed cards lose their controls',()=>{
 assert.deepEqual(approvalChange(['a','b'],['b','a']),{removed:[],added:[]});
 assert.deepEqual(approvalChange(['a'],[]),{removed:['a'],added:[]});
 assert.deepEqual(approvalChange(['a'],undefined),{removed:[],added:[]});
 assert.deepEqual(approvalChange(['a'],['a','b']),{removed:[],added:['b']});
});
