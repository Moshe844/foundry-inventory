'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('Hebrew and French headers share field meanings across formats',()=>{
 const fields=require('../../src/imports/fields');
 for(const [header,field]of [['מק"ט','code'],['מק״ט','code'],['שם מוצר','name'],['כמות','quantity'],['Article','name'],['Qté','quantity'],['Prix','sellingPrice'],['Coût unitaire','unitCost']])assert.equal(fields.bestFieldScores(header)[0]?.field,field,header);
});
test('PDF RTL runs preserve logical word order without reversing SKU or numeric columns',()=>{
 const {tabulatePage}=require('../../src/imports/pdf-table');
 const rows=tabulatePage([{cells:[{x:20,text:'AB-19',dir:'ltr'},{x:210,text:'כחול',dir:'rtl'},{x:250,text:'שולחן',dir:'rtl'},{x:400,text:'12.75',dir:'ltr'}]}],[20,250,400]);
 assert.deepEqual(rows,[['AB-19','שולחן כחול','12.75']]);
});
test('a real Hebrew PDF preserves header and product text through pdf.js extraction',async()=>{
 const PDF=require('pdfkit'),path=require('node:path'),doc=new PDF({size:'A4',margin:20}),chunks=[];
 const done=new Promise((r,j)=>{doc.on('data',c=>chunks.push(c));doc.on('end',r);doc.on('error',j);});
 const font=path.resolve(__dirname,'../fixtures/fonts/NotoSansHebrew.ttf');
 doc.font(font).fontSize(12);const headerNext=200+doc.widthOfString('מוצר')+6,nameNext=200+doc.widthOfString('כחולה')+6;
 for(const [text,x]of [['מק״ט',40],['מוצר',200],['שם',headerNext],['כמות',350],['מחיר',450]])doc.font(font).fontSize(12).text(text,x,40,{lineBreak:false});
 doc.font('Helvetica').text('FRESH-19',40,75,{lineBreak:false});doc.font(font).text('כחולה',200,75,{lineBreak:false}).text('מחברת',nameNext,75,{lineBreak:false});doc.font('Helvetica').text('7',350,75,{lineBreak:false}).text('12.75',450,75,{lineBreak:false});doc.end();await done;
 const parsed=await require('../../src/imports/pdf-table').parse(Buffer.concat(chunks)),sheet=parsed.sheets[0];
 assert.deepEqual(sheet.columns.map(c=>c.name),['מק״ט','שם מוצר','כמות','מחיר']);assert.deepEqual(sheet.rows[0].cells,['FRESH-19','מחברת כחולה','7','12.75']);
});
test('package weight accepts metric and imperial units with one server-side cap',()=>{
 const {boxes,MAX_WEIGHT_GRAMS}=require('../../src/shipping/parcel-contract');
 for(const [weight,weightUnit,grams]of [['2.5','kg',2500],['1','lb',454],['4','oz',114]])assert.equal(boxes([{weight,weightUnit}])[0].weightGrams,grams);
 assert.equal(boxes([{weightGrams:MAX_WEIGHT_GRAMS}])[0].weightGrams,MAX_WEIGHT_GRAMS);
 assert.throws(()=>boxes([{weight:'1000.001',weightUnit:'kg'}]),/exceeds 1,000 kg/);
 assert.throws(()=>boxes([{weightGrams:MAX_WEIGHT_GRAMS+1}]),/exceeds/);
 assert.throws(()=>boxes([{weight:'-1',weightUnit:'lb'}]),/positive/);
});
test('USPS, UPS and FedEx tracking use encoded carrier-owned links',()=>{
 const carriers=require('../../src/sales/carriers');
 for(const [carrier,host]of [['USPS','tools.usps.com'],['UPS','www.ups.com'],['FedEx','www.fedex.com']]){
  const url=new URL(carriers.trackingUrlFor(carrier,'ABC & 123'));assert.equal(url.hostname,host);assert.ok(url.href.includes('%26'));
 }
 assert.equal(carriers.trackingUrlFor('unknown','ABC'),null);
});
test('streamed CSV escapes spreadsheet formulas and retains exact money',()=>{
 const {cell,queries}=require('../../src/operations/postgres-export-stream');
 assert.equal(cell('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');assert.equal(cell(12345),'"12345"');
 assert.ok(queries(null).every(([,sql])=>sql.includes('workspace_id=$1')));
 assert.ok(queries(['item']).every(([,sql])=>sql.includes('$2::text[]')));
});
test('AI spending warning starts at 80 percent without changing or bypassing the ceiling',async()=>{
 const budget=require('../../src/commercial/model-cost-budget');let used=1999;
 const db={query:async sql=>({rows:sql.includes('SELECT owner_account_id')?[{owner_account_id:'owner'}]:sql.includes('FROM account_subscriptions')?[]:[{account:used,workspace:used}]})};
 assert.equal((await budget.status(db,'workspace')).warning,false);used=2000;assert.equal((await budget.status(db,'workspace')).warning,true);
 used=2500;assert.equal((await budget.status(db,'workspace')).blocked,true);assert.equal((await budget.status(db,'workspace')).accountCapMinor,2500);
});
test('shipping provider failures use business language while retaining status separately',()=>{
 const {message}=require('../../src/shipping/public-error');
 assert.match(message(401,'HTTP 401','Shippo'),/authorize/);assert.match(message(429,'HTTP 429','Shippo'),/limiting/);assert.match(message(503,'HTTP 503','Shippo'),/original operation/);
 assert.doesNotMatch(message(400,'HTTP 400: Address not recognized','Shippo'),/HTTP 400/);
});
test('Sola uses private server credentials and secure tokens, never retrying a charge blindly',async()=>{
 const adapter=require('../../src/payments/providers/cardknox');let received;
 const fetch=async(url,request,options)=>{received={url,request,options};return {ok:true,json:async()=>({xResult:'A',xRefNum:'test-reference'})};};
 await adapter.sale({cardknoxApiKey:'private-test-merchant',cardknoxOptions:{fetch}},{cardToken:'secure-card-sut-0123456789012345',cvvToken:'secure-cvv-sut-0123456789012345',expiry:'0130',amountMinor:1275,currency:'USD',reference:'request-unique'});
 const payload=JSON.parse(received.request.body);assert.equal(payload.xKey,'private-test-merchant');assert.equal(payload.xAmount,'12.75');assert.equal(payload.xAllowDuplicate,'FALSE');assert.equal(payload.xCustReceipt,'FALSE');assert.equal(received.options.retries,0);assert.equal(received.request.headers['idempotency-key'],undefined);
 await assert.rejects(adapter.sale({cardknoxApiKey:'private'}, {cardToken:'4444333322221111',cvvToken:'123'}),/not accepted/);
});
test('CSV and workbook reading expose the same configurable capacity without truncating rows',()=>{
 const cp=require('node:child_process'),path=require('node:path');
 const result=cp.execFileSync(process.execPath,['-e',`const p=require('./src/imports/parser'),x=require('./src/imports/xlsx-reader');if(p.LIMITS.maxRows!==50||x.LIMITS.maxRows!==50)throw Error('Capacity mismatch');let caught=false;try{p.parseText('Name,SKU,Quantity\\n'+Array.from({length:51},(_,n)=>'Item '+n+',SKU-'+n+',1').join('\\n'));}catch(e){caught=/capacity|rows/.test(e.message);}if(!caught)throw Error('Rows were silently accepted or truncated');`],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,FOUNDRY_IMPORT_MAX_ROWS:'50'},windowsHide:true});assert.equal(result.length,0);
});
