'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const exportsFor=require('../../src/reports/exports'),ask=require('../../src/assistant/ask-export');

// The parts of a zip by name, read from its local headers.
function parts(buffer){
  const found={};let at=0;
  while(buffer.readUInt32LE(at)===0x04034b50){
    const size=buffer.readUInt32LE(at+18),nameLength=buffer.readUInt16LE(at+26),extra=buffer.readUInt16LE(at+28),date=buffer.readUInt16LE(at+12);
    const name=buffer.subarray(at+30,at+30+nameLength).toString(),data=buffer.subarray(at+30+nameLength+extra,at+30+nameLength+extra+size);
    found[name]={text:zlib.inflateRawSync(data).toString('utf8'),date};at+=30+nameLength+extra+size;
  }
  return found;
}

test('an Excel file declares each part with the type Excel checks, and holds any column, character and figure',()=>{
  const columns=Array.from({length:30},(_,index)=>'c'+index);
  const file=parts(exportsFor.xlsx({columns,columnLabels:{c1:'Name'},rows:[Object.fromEntries(columns.map((column,index)=>[column,
    index===1?'  Bell\u0007 and dash \u2013 kept':index===2?'4':index===3?'00123':index===4?'0123456789012':index===5?'12.5':'x'+index]))]}));
  assert.match(file['[Content_Types].xml'].text,/PartName="\/xl\/workbook\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml"/,'the workbook part is not labelled with the download type');
  for(const [name,{date}] of Object.entries(file))assert.ok((date>>5&15)>=1&&(date&31)>=1,name+' has a real date');
  const sheet=file['xl/worksheets/sheet1.xml'].text;
  assert.match(sheet,/<c r="AA1" t="inlineStr">/,'columns after Z are AA, AB...');assert.match(sheet,/<c r="AD2"/);assert.doesNotMatch(sheet,/r="\[/);
  assert.doesNotMatch(sheet,/\u0007/,'a character XML cannot hold is left out');
  assert.match(sheet,/<t xml:space="preserve">  Bell and dash \u2013 kept<\/t>/,'leading spaces and the dash stay');
  assert.match(sheet,/<c r="C2"><v>4<\/v><\/c>/,'a figure saved as text goes in as a number');
  assert.match(sheet,/<c r="F2"><v>12\.5<\/v><\/c>/);
  assert.match(sheet,/<c r="D2" t="inlineStr"><is><t xml:space="preserve">00123<\/t>/,'a code with a leading zero stays text');
  assert.match(sheet,/<c r="E2" t="inlineStr"><is><t xml:space="preserve">0123456789012<\/t>/,'a barcode stays text');
  const typed=parts(exportsFor.xlsx({columns:['sku'],columnTypes:{sku:'text'},rows:[{sku:'12345'}],displayRows:[{sku:'12345'}]}))['xl/worksheets/sheet1.xml'].text;
  assert.match(typed,/<c r="A2" t="inlineStr">/,'a column declared as text stays text');
});

test('every CSV starts with the UTF-8 mark Excel needs to read dashes and accents',()=>{
  const text=exportsFor.csv({columns:['name'],columnLabels:{name:'Name'},rows:[{name:'Caf\u00e9 \u2013 north'}],displayRows:[{name:'Caf\u00e9 \u2013 north'}]}).toString('utf8');
  assert.equal(text.charCodeAt(0),0xfeff);assert.match(text,/^\uFEFF"Name"\r\n"Caf\u00e9 \u2013 north"\r\n$/);
});

test('Download answer as a spreadsheet gives the tables of the answer in columns; the PDF and table-less answers keep the words',()=>{
  const found={original_request:'What sold best?',answer:'Best sellers, Nov 1 \u2013 Nov 10:\n\n| Product | SKU | Units |\n|---|---|---:|\n| **Glass 10** | GLS-010 | 5 |\n| Glass 3 | GLS-003 | 3 |\n\n### Returns\n\n| Product | Returned |\n|---|---|\n| Glass 3 | 1 |'};
  for(const format of ['csv','xlsx']){
    const sheet=ask.goal(found,undefined,true,format);
    assert.deepEqual(sheet.columns.map(column=>sheet.columnLabels[column]),['Product','SKU','Units'],format);
    assert.deepEqual(sheet.rows.map(row=>Object.values(row)),[['Glass 10','GLS-010','5'],['Glass 3','GLS-003','3'],['','',''],['Returns','',''],['Product','Returned',''],['Glass 3','1','']],format+': a second table follows its heading');
  }
  const single=ask.goal({...found,answer:found.answer.split('\n\n### Returns')[0]},undefined,true,'csv');
  assert.equal(exportsFor.csv(single).toString(),'\uFEFF"Product","SKU","Units"\r\n"Glass 10","GLS-010","5"\r\n"Glass 3","GLS-003","3"\r\n');
  assert.deepEqual(ask.goal(found,undefined,true,'pdf').columns,['answer'],'the PDF of the answer is its words');
  const words=ask.goal({answer:'Nothing is due. '+'word '.repeat(70)},undefined,true,'csv');
  assert.deepEqual(words.columns,['answer'],'an answer with no table downloads as its words');
  assert.ok(words.rows.length>1&&words.rows.every(row=>!/\bwor$|^rd\b/.test(row.answer)),'long lines break between words');
});

test('a download is offered only for an answer worth keeping',()=>{
  assert.equal(ask.worthKeeping('Opening Purchasing.',0),false,'a page hand-off is not a document');
  assert.equal(ask.worthKeeping('You have 12 customers.',0),false);
  assert.equal(ask.worthKeeping('Best sellers: A 5; B 3.',3),true,'an answer with records');
  assert.equal(ask.worthKeeping('| Product | Units |\n|---|---|\n| A | 5 |',0),true,'an answer with a table');
  assert.equal(ask.worthKeeping('word '.repeat(ask.LONG_ANSWER/5+1),0),true,'a written report');
});
