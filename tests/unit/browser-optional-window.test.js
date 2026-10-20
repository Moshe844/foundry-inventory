'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{compact,expand}=require('../../scripts/environment-agent-demo/browser-presentation');
test('optional undefined picker metadata cannot manufacture repeated inspection notices on ordinary live controls',()=>{
 const control={tag:'a',label:'Unfamiliar destination',href:'/unknown',options:undefined,optionsOffset:undefined,optionsTotal:undefined,optionsTruncated:false},original={controls:Array.from({length:100},(_,i)=>({...control,ref:String(i),label:'Destination '+i})),pagination:{controlOffset:0,controlTotal:100,controlsNextRef:null}};
 const encoded=compact(original),wire=JSON.stringify(encoded);assert(encoded.controlDefaults);assert(encoded.controls.every(c=>!Object.hasOwn(c,'_stockchiefInspectionWindow')));assert.equal(wire.split('does not mean').length-1,1,'The one page-window notice suffices for non-pickers');assert.deepEqual(JSON.parse(JSON.stringify(expand(encoded))),JSON.parse(JSON.stringify(original)));
 const picker={controls:[{tag:'select',label:'Actual picker',options:[{label:'Choice',value:'x'}],optionsOffset:0,optionsTotal:12,optionsTruncated:true,optionsNextRef:'next-options'}]};const kept=compact(picker);assert.equal(kept.controls[0]._stockchiefInspectionWindow.options.optionsNextRef,'next-options');assert.deepEqual(expand(kept),picker);
});
