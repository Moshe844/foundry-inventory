'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {parse,dimensions}=require('../../src/imports/image-table');
const {scannedTableImage}=require('../helpers/scanned-table-pdf');

test('clear inventory image becomes an OCR table without header rewriting', {timeout:120000},async()=>{
  const source=scannedTableImage();
  assert.deepEqual(dimensions(source),{width:1100,height:480});
  const parsed=await parse(source);
  assert.equal(parsed.format,'image');
  assert.deepEqual(parsed.sheets[0].columns.map((column)=>column.name),['Product','SKU','Quantity']);
  assert.equal(parsed.sheets[0].rows.length,2);
  assert.match(parsed.sheets[0].rows[1].cells.join(' '),/Wall Light.*LIGHT-20.*4/);
});

test('image parser refuses unsafe dimensions and other binary content',async()=>{
  const huge=Buffer.from(scannedTableImage());
  huge.writeUInt32BE(100000,16);
  await assert.rejects(parse(huge),/too large to read safely/i);
  await assert.rejects(parse(Buffer.from('not an image')),/readable PNG or JPEG/i);
});

test('JPEG photo of an inventory table is read as a preview', {timeout:120000},async()=>{
  const source=scannedTableImage({format:'jpeg'});
  assert.deepEqual(dimensions(source),{width:1100,height:480});
  const parsed=await parse(source);
  assert.equal(parsed.sheets[0].rows.length,2);
  assert.match(parsed.sheets[0].rows[0].cells.join(' '),/Desk Lamp.*LAMP-10.*3/);
});
