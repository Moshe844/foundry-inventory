'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');
const render=(template,data)=>ejs.render(template,{...data,approvalReview:require('../../src/imports/approval-review').review(data.plan,{...data,needsNumberAnswer:false})},{filename:path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs')});

test('approved imports show execution guidance without stale preview-only instructions',()=>{
 const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
 for(const state of ['APPROVED','QUEUED','NEEDS_REVIEW','VERIFIED']){
  const html=render(template,{plan:{id:'approved-source',sourceName:'Source.csv',status:state==='VERIFIED'?'SUCCEEDED':'READY',approvalStatus:'APPROVED',recordsDetected:1,recordsValid:1,recordsInvalid:0,integrityHash:'frozen',fieldMappings:{name:0,quantity:1},transformations:{},warnings:[],conflicts:[]},
   previewRevision:{active:false,label:'Preview updated',processedRows:1,totalRows:1,lastUpdateAt:'2026-01-01T12:00:00Z',state:'COMPLETED'},
   importProgress:{active:state==='QUEUED',state,label:state,stage:state.toLowerCase(),stageLabel:state,verified:state==='VERIFIED',processedRows:null,progressPercent:null,readyRows:1},
   run:state==='NEEDS_REVIEW'?{id:'failed',status:'FAILED',stage:'rolled_back',verified:false}:state==='VERIFIED'?{id:'saved',status:'SUCCEEDED',verified:true,rowsImported:1,itemsCreated:1,skusCreated:1,unitsEstablished:2,checks:[]}:null,
   duplicatePlans:[],csrfToken:'csrf',mappingRows:[],fieldOptions:[],locations:[],counts:{VALID:1},rows:[],page:1,pageSize:50,helpers:{plural:(n,s)=>n===1?s:s+'s',qty:n=>String(n)}});
  assert.doesNotMatch(html,/Preview updated|No stock or Money is being imported/);assert.match(html,/data-import-current-step/);
 }
});

test('a legacy staged import with absent money fields never presents NaN as a price',()=>{
  const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
  const html=render(template,{
    plan:{id:'fixture',sourceName:'old.xlsx',recordsDetected:1,recordsValid:1,recordsInvalid:0,
      status:'READY',warnings:[],conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'test'},
    duplicatePlans:[],run:null,importProgress:{active:false,label:'Preview awaiting approval'},csrfToken:'test',mappingRows:[],fieldOptions:[],locations:[],
    counts:{VALID:1},rows:[{rowNumber:2,status:'VALID',problems:[],parsed:{name:'Old Item',
      code:'OLD-1',quantity:3,currency:'USD'}}],page:1,pageSize:25,
    helpers:{plural:(count,singular)=>count===1?singular:`${singular}s`},
  });
  assert.doesNotMatch(html,/NaN|undefined/);
  assert.match(html,/Not provided/);
});

test('complete source identifiers do not ask for another upload or tracking confirmation',()=>{
 const html=render(fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8'),{
  plan:{id:'complete',sourceName:'mixed.xlsx',fieldMappings:{name:0,quantity:1,serial:2,serialTracked:3},transformations:{},recordsDetected:1,recordsValid:1,recordsInvalid:0,status:'READY',warnings:[],conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'frozen'},
  duplicatePlans:[],run:null,importProgress:{active:false,label:'Preview awaiting approval'},csrfToken:'csrf',mappingRows:[],fieldOptions:[],locations:[],counts:{VALID:1},rows:[],page:1,pageSize:50,
  trackingQuestion:{state:'complete',groups:[{mode:'serial',label:'Serial-number',sourceSkus:1,missingSkus:0,decision:'source',canUseQuantity:false}]},helpers:{plural:(n,s)=>n===1?s:s+'s'}});
 assert.match(html,/No tracking information is missing/);assert.doesNotMatch(html,/Upload the completed source|name="tracking_serial"|StockChief needs one confirmation/);assert.match(html,/Approve 1 row<\/button>/);
});

test('a quantity-only interpretation still prompts for an identity column and cannot be approved',()=>{
  const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
  const html=render(template,{
    plan:{id:'quantity-only',sourceName:'opaque.csv',detectedType:'inventory',fieldMappings:{quantity:1},
      transformations:{},recordsDetected:1,recordsValid:0,recordsInvalid:1,status:'READY',warnings:[],
      conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'test'},
    duplicatePlans:[],run:null,importProgress:{active:false,label:'Preview awaiting approval'},csrfToken:'test',mappingRows:[{index:0,column:'Alpha',field:null},
      {index:1,column:'Beta',field:'quantity'}],fieldOptions:[{id:'name',label:'Product name'},
      {id:'quantity',label:'Quantity'}],locations:[],counts:{INVALID:1},rows:[],page:1,pageSize:25,
    helpers:{plural:(count,singular)=>count===1?singular:`${singular}s`},
  });
  assert.match(html,/which values identify your products/);
  assert.match(html,/You do not need to change or re-upload your file/);
  assert.match(html,/Before you can import/);
  assert.doesNotMatch(html,/action="[^"]*\/approve"/);assert.match(html,/data-import-next-step/);
});

test('tracking clarification is presented in the product with an explicit preview-only choice',()=>{
 const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
 const html=render(template,{plan:{id:'tracking',sourceName:'tracked.xlsx',fieldMappings:{name:0,quantity:1,serialTracked:2},transformations:{workbook:{sourceRows:400,outputRows:800,coverage:[]}},recordsDetected:800,recordsValid:0,recordsInvalid:800,status:'READY',warnings:[],conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'frozen'},
 duplicatePlans:[],run:null,importProgress:{active:false,label:'Preview awaiting approval'},csrfToken:'csrf',mappingRows:[],fieldOptions:[],locations:[],counts:{INVALID:800},rows:[],page:1,pageSize:50,
 trackingQuestion:{kind:'tracking_requirements',state:'needs_input',groups:[{mode:'serial',label:'Serial-number',sourceSkus:400,missingSkus:400,decision:'source',canUseQuantity:true}]},helpers:{plural:(n,s)=>n===1?s:s+'s'}});
 assert.match(html,/Do these products need serial numbers or batch tracking/);assert.match(html,/name="tracking_serial"/);assert.match(html,/type="radio"/);assert.doesNotMatch(html,/value="quantity" checked/);assert.match(html,/name="confirmTrackingChange"/);assert.match(html,/Nothing is imported until you review and approve/);assert.doesNotMatch(html,/action="[^"]*\/approve"/);assert.match(html,/data-import-next-step/);assert.doesNotMatch(html,/undefined|NaN/);
});
