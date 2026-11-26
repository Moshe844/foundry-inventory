'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCanvas}=require('@napi-rs/canvas');
const images=require('../../src/imports/image-table');

test('conflicting numeric OCR evidence is reread and retained for owner review',async()=>{
  const canvas=createCanvas(600,180),context=canvas.getContext('2d');
  context.fillStyle='white';context.fillRect(0,0,600,180);
  const word=(text,x,y)=>({text,confidence:95,bbox:{x0:x,y0:y,x1:x+text.length*8,y1:y+12}});
  const headings=[word('SKU',20,20),word('Product name',150,20),word('Quantity',400,20)];
  const full=[...headings,word('FIXTURE-7',20,100),word('Canvas liner',150,100),word('7',400,100)];
  // The body starts at y=39 after the heading band. Simulate independent
  // full-page, column and enlarged-cell observations of the same source.
  const readings=[full,headings,[word('FIXTURE-7',12,61)],[word('2',12,61)],[word('7',12,5)]];
  const worker={setParameters:async()=>{},recognize:async()=>{
    assert(readings.length,'Unexpected additional OCR request');
    return {data:{blocks:[{paragraphs:[{lines:[{words:readings.shift()}]}]}]}};
  }};
  const sheet=await images.readStructuredTable(canvas,worker);
  const mapping=require('../../src/imports/fields').guessMappings(sheet.columns,sheet.rows).mappings;
  assert.equal(sheet.rows[0].cells[mapping.quantity],'7');
  const issue=sheet.rows[0].problems.find(p=>p.code==='image_quantity_uncertain');
  assert.equal(issue?.field,'quantity');
  assert.deepEqual(issue.readings,['7','2','7']);
  assert.equal(readings.length,0);
});
