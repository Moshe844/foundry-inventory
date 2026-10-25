'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{ProductBrain}=require('../../src/product-brain/registry'),catalog=require('../../src/product-brain/catalog');
test('manufacturing capability truth follows the implemented persistence runtime',()=>{
 assert.equal(new ProductBrain({...catalog,runtime:'postgresql'}).capability('manufacturing.manage').status,'available');
 assert.equal(new ProductBrain(catalog).capability('manufacturing.manage').status,'unavailable');
});
