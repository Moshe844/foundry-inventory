'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {plan,clock,minute}=require('../../src/shipping/van-route-plan');

test('allocates multiple vans using directed road time, service windows, capacity, and return to depot',()=>{
  const vans=[{id:'north',start:480,end:540,capacityGrams:1000},{id:'south',start:495,end:555,capacityGrams:1800}];
  const stops=[
    {id:'early',opens:488,closes:510,serviceMinutes:6,weightGrams:600},
    {id:'later',opens:518,closes:547,serviceMinutes:5,weightGrams:950},
    {id:'middle',opens:510,closes:535,serviceMinutes:4,weightGrams:360},
    {id:'overweight',opens:500,closes:535,serviceMinutes:4,weightGrams:2000}
  ];
  const road=[[0,431,900,660,420],[480,0,540,180,300],[600,480,0,120,540],[420,780,180,0,420],[420,360,480,420,0]];
  const routes=plan(stops,vans,road);
  assert.deepEqual(routes.routes,[
    {vehicleId:'north',start:480,stops:[{id:'early',arrival:488,leave:494},{id:'middle',arrival:510,leave:514}],
      loadGrams:960,roadMinutes:18,returnAt:521},
    {vehicleId:'south',start:495,stops:[{id:'later',arrival:518,leave:523}],loadGrams:950,roadMinutes:25,returnAt:533}
  ]);
  assert.match(routes.unassigned[0].reason,/capacity/);
  assert.deepEqual(plan(stops,vans,road),routes);
  assert.equal(clock(minute('08:05','departure')),'08:05');
});

test('unreachable roads and a late return stay unresolved instead of publishing impossible arrival times',()=>{
  const van=[{id:'van',start:480,end:510,capacityGrams:1000}];
  const stops=[
    {id:'unreachable',opens:480,closes:510,serviceMinutes:5,weightGrams:100},
    {id:'late-return',opens:480,closes:510,serviceMinutes:10,weightGrams:100}
  ];
  const result=plan(stops,van,[[0,null,600],[480,0,null],[900,null,0]]);
  assert.equal(result.routes.length,0);
  assert.match(result.unassigned[1].reason,/Road times/);
  assert.throws(()=>plan(stops,van,[[0,1],[1,0]]),/both directions/);
  assert.throws(()=>plan(stops,van,[[0,-2,1],[1,0,1],[1,1,0]]),/travel seconds/);
});
