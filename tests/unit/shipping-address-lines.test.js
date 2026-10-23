'use strict';const test=require('node:test'),assert=require('node:assert/strict'),address=require('../../src/shipping/address');
test('postal secondary lines are preserved and cannot become the city',()=>{
 for(const extra of ['Floor 12','3rd Floor','Suite 402','Apt 9','Building B','Room 7']){
  const result=address.parse('Example business\n123 Market Street\n'+extra+'\nAlbany\nNY 12207');assert.equal(result.complete,true);assert.equal(result.line1,'123 Market Street');assert.equal(result.line2,extra);assert.equal(result.city,'Albany');
 }
});
test('several secondary lines remain evidenced instead of silently disappearing',()=>{
 const result=address.parse('123 Market Street\nBuilding B\nFloor 12\nAlbany, NY 12207');assert.equal(result.city,'Albany');assert.equal(result.line2,'Building B, Floor 12');
});
