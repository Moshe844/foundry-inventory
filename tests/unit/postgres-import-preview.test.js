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
