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

test('inconsistent image money punctuation requires review without manufacturing cents',{timeout:120000},async()=>{
 const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1300,500),c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,1300,500);c.fillStyle='#173852';c.fillRect(0,30,1300,60);c.fillStyle='#fff';c.font='25px Arial';
 for(const[x,s]of [[30,'SKU'],[350,'Product Name'],[800,'Quantity'],[1050,'Unit Cost']])c.fillText(s,x,70);
 c.fillStyle='#172c40';for(const[i,row]of [['TRAY-41','Copper tray','2','$640'],['CUP-59','Ceramic cup','3','$8.25'],['BOWL-76','Stone bowl','4','$4.50']].entries())for(const[j,x]of [30,350,800,1050].entries())c.fillText(row[j],x,160+i*75);
 const sheet=(await parse(canvas.toBuffer('image/png'))).sheets[0];assert.equal(sheet.rows.length,3);assert.equal(sheet.rows[0].cells[3].replace(/[$, ]/g,''),'640');assert(sheet.rows[0].problems.some(p=>p.code==='image_money_uncertain'&&p.field==='unitCost'),'mixed punctuation is a review question, never an invented decimal');
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

test('decorated inventory image reads its later dark table header rather than summary cards',{timeout:120000},async()=>{
 const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1300,580),c=canvas.getContext('2d');
 c.fillStyle='#fff';c.fillRect(0,0,1300,580);c.fillStyle='#24384d';c.font='28px Arial';c.fillText('Monthly operations overview',30,45);
 for(const [x,label,n]of [[25,'Products',910],[355,'Units',34000],[685,'Value',789000]]){c.fillStyle='#e5edf7';c.fillRect(x,70,295,90);c.fillStyle='#172d42';c.font='20px Arial';c.fillText(label,x+20,100);c.font='30px Arial';c.fillText(String(n),x+20,140);}
 c.fillStyle='#173852';c.fillRect(10,210,1280,50);c.fillStyle='#fff';c.font='23px Arial';
 for(const [x,text]of [[35,'SKU'],[300,'Product Name'],[800,'On Hand'],[1050,'Unit Cost']])c.fillText(text,x,243);
 c.fillStyle='#182b40';c.font='24px Arial';const data=[['FAN-82','Portable fan','17','$8.25'],['MAT-93','Rubber mat','0','$4.50'],['HOOK-14','Steel hook','6','$1.20']];
 for(const [i,row]of data.entries())for(const [j,x]of [35,300,800,1050].entries())c.fillText(row[j],x,315+i*65);
 const parsed=await parse(canvas.toBuffer('image/png')),sheet=parsed.sheets[0];
 assert.deepEqual(sheet.columns.map(c=>c.name),['SKU','Product Name','On Hand','Unit Cost']);assert.equal(sheet.rows.length,3);
 assert.equal(sheet.rows[0].cells[0],'FAN-82');assert.equal(sheet.rows[1].cells[2],'0');assert.equal(sheet.rows[2].cells[3],'$1.20');
});
