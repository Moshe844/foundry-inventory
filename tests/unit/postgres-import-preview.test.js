'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ejs=require('ejs');

test('a legacy staged import with absent money fields never presents NaN as a price',()=>{
  const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
  const html=ejs.render(template,{
    plan:{id:'fixture',sourceName:'old.xlsx',recordsDetected:1,recordsValid:1,recordsInvalid:0,
      status:'READY',warnings:[],conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'test'},
    duplicatePlans:[],run:null,csrfToken:'test',mappingRows:[],fieldOptions:[],locations:[],
    counts:{VALID:1},rows:[{rowNumber:2,status:'VALID',problems:[],parsed:{name:'Old Item',
      code:'OLD-1',quantity:3,currency:'USD'}}],page:1,pageSize:25,
    helpers:{plural:(count,singular)=>count===1?singular:`${singular}s`},
  });
  assert.doesNotMatch(html,/NaN|undefined/);
  assert.match(html,/Not provided/);
});

test('a quantity-only interpretation still prompts for an identity column and cannot be approved',()=>{
  const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/imports/postgres-preview.ejs'),'utf8');
  const html=ejs.render(template,{
    plan:{id:'quantity-only',sourceName:'opaque.csv',detectedType:'inventory',fieldMappings:{quantity:1},
      transformations:{},recordsDetected:1,recordsValid:0,recordsInvalid:1,status:'READY',warnings:[],
      conflicts:[],approvalStatus:'AWAITING_APPROVAL',integrityHash:'test'},
    duplicatePlans:[],run:null,csrfToken:'test',mappingRows:[{index:0,column:'Alpha',field:null},
      {index:1,column:'Beta',field:'quantity'}],fieldOptions:[{id:'name',label:'Product name'},
      {id:'quantity',label:'Quantity'}],locations:[],counts:{INVALID:1},rows:[],page:1,pageSize:25,
    helpers:{plural:(count,singular)=>count===1?singular:`${singular}s`},
  });
  assert.match(html,/which values identify your products/);
  assert.match(html,/You do not need to change or re-upload your file/);
  assert.match(html,/Approve 0 rows<\/button>/);
  assert.match(html,/disabled[^>]*>Approve 0 rows/);
});
