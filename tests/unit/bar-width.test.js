'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{barWidth}=require('../../src/web/view-helpers');
test('a bar for any part that is not zero stays visible, however small its share',()=>{
 assert.equal(barWidth(32,52574),'max(4px, 0.06%)','a tiny share is a sliver, not an empty track');
 assert.equal(barWidth(49,71),'max(4px, 69.01%)');
 assert.equal(barWidth(-500,1000),'max(4px, 50%)','a loss is drawn by its size');
 assert.equal(barWidth(150,100),'max(4px, 100%)','never past the whole');
 assert.equal(barWidth(0,100),'0%','nothing draws nothing');
 assert.equal(barWidth(5,0),'0%');
});
