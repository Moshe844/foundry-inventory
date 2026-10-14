'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const codec=require('../../scripts/environment-agent-demo/browser-presentation');
test('browser text has one lossless source, while every line, field and action remains retrievable',()=>{
 const text=' New screen \n\n Changed form \r\n Quantity: 37\n';
 const original={text,textBlocks:{line0:'New screen',line1:'Changed form',line2:'Quantity: 37'},
  controls:[{ref:'live-unknown',name:'new_field',value:'37',required:true,form:{method:'post',action:'/unknown'},options:[{value:'x',label:'Unfamiliar'}]}]};
 const wire=codec.compact(original);assert.equal(wire.text,text);assert.equal(wire.textBlocks,undefined);
 assert.deepEqual(codec.expand(wire),original);assert.deepEqual(wire.controls,original.controls);
 assert.deepEqual(codec.expand(codec.compact({screen:original,image:{base64:'unchanged'}})),{screen:original,image:{base64:'unchanged'}});
});
test('non-generated text blocks are preserved rather than guessed or discarded',()=>{
 const original={text:'different',textBlocks:{field:'Independent information'},controls:[]};
 assert.deepEqual(codec.expand(codec.compact(original)),original);
});
test('existing default encoding still restores all original field metadata',()=>{
 const defaults={type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false};
 const original={text:'Information',textBlocks:{line0:'Information'},controls:[{...defaults,ref:'dynamic1',tag:'input',value:'5'},{...defaults,ref:'dynamic2',required:true,tag:'button',label:'Proceed'}]};
 assert.deepEqual(codec.expand(codec.compact(original)),original);
});
