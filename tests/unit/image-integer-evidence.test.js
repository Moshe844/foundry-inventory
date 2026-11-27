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

for(const recovered of ['4',''])test('an empty numeric OCR cell is reread without inventing a value: '+(recovered||'blank'),async()=>{
  const canvas=createCanvas(600,180),context=canvas.getContext('2d');
  context.fillStyle='white';context.fillRect(0,0,600,180);
  const word=(text,x,y)=>({text,confidence:95,bbox:{x0:x,y0:y,x1:x+text.length*8,y1:y+12}});
  const headings=[word('SKU',20,20),word('Product name',150,20),word('Quantity',400,20)];
  const full=[...headings,word('FIXTURE-4',20,100),word('Canvas liner',150,100)];
  const readings=[full,headings,[word('FIXTURE-4',12,61)],[],recovered?[word(recovered,12,5)]:[]];
  const worker={setParameters:async()=>{},recognize:async()=>{
    assert(readings.length,'Unexpected additional OCR request');
    return {data:{blocks:[{paragraphs:[{lines:[{words:readings.shift()}]}]}]}};
  }};
  const sheet=await images.readStructuredTable(canvas,worker);
  const mapping=require('../../src/imports/fields').guessMappings(sheet.columns,sheet.rows).mappings;
  assert.equal(sheet.rows[0].cells[mapping.quantity],recovered);
  const issue=sheet.rows[0].problems.find(p=>p.code==='image_quantity_uncertain');
  if(recovered){assert.equal(issue?.field,'quantity');assert.deepEqual(issue.readings,['4']);}
  else assert.equal(issue,undefined,'No source evidence may be turned into zero or another invented value');
  assert.equal(readings.length,0);
});

for(const strongSource of ['page','column','neither'])test('a low-confidence cell reread cannot replace stronger '+strongSource+' evidence',async()=>{
  const canvas=createCanvas(600,180),context=canvas.getContext('2d');
  context.fillStyle='white';context.fillRect(0,0,600,180);
  const word=(text,x,y,confidence=95)=>({text,confidence,bbox:{x0:x,y0:y,x1:x+text.length*8,y1:y+12}});
  const headings=[word('SKU',20,20),word('Product name',150,20),word('Quantity',400,20)];
  const page=strongSource==='page'?['7',92]:strongSource==='neither'?['',0]:['4',52],column=strongSource==='column'?['7',92]:strongSource==='neither'?['5',47]:['4',52];
  const full=[...headings,word('FIXTURE-7',20,100),word('Canvas liner',150,100),word(page[0],400,100,page[1])];
  const readings=[full,headings,[word('FIXTURE-7',12,61)],[word(column[0],12,61,column[1])],[word(strongSource==='neither'?'0':'4',12,5,strongSource==='neither'?52:38)]];
  const worker={setParameters:async()=>{},recognize:async()=>{
    assert(readings.length,'Unexpected additional OCR request');
    return {data:{blocks:[{paragraphs:[{lines:[{words:readings.shift()}]}]}]}};
  }};
  const sheet=await images.readStructuredTable(canvas,worker),mapping=require('../../src/imports/fields').guessMappings(sheet.columns,sheet.rows).mappings;
  assert.equal(sheet.rows[0].cells[mapping.quantity],strongSource==='neither'?'5':'7');
  assert(sheet.rows[0].problems.some(p=>p.code==='image_quantity_uncertain'&&p.readings.includes(strongSource==='neither'?'0':'4')),'Conflicting evidence still requires source review');
  assert.equal(readings.length,0);
});
