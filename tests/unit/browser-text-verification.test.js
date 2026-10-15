'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {unchangedLine}=require('../../src/assistant/browser-text-verification');
test('all thirteen actual live claims survive the recorded Back-link removal without changing any value',()=>{
 const fixture=require('../fixtures/codex-browser-line-shift.json');
 for(const claim of fixture.claims){
  assert.notEqual(fixture.current.textBlocks[claim.path.split('/').at(-1)],claim.value,'The original positional check really fails');
  const result=unchangedLine(fixture.previous,fixture.current,claim.path);
  assert.equal(result.matched,true,claim.path);assert.equal(result.value,claim.value);
 }
 const reversed={textBlocks:Object.fromEntries(Object.entries(fixture.previous.textBlocks).reverse())};
 assert.equal(unchangedLine(reversed,fixture.current,fixture.claims[0].path).matched,true,'JSON object ordering is not evidence identity');
});
function observation(lines,regions=[]){return {textBlocks:Object.fromEntries(lines.map((line,i)=>['line'+i,line])),
 textRegions:regions.map(([firstLine,count])=>({firstLine,count,tag:'form',sha256:createHash('sha256').update(JSON.stringify(lines.slice(firstLine,firstLine+count))).digest('hex')}))};}
test('a repeated old quantity elsewhere cannot substitute for changed business evidence',()=>{
 const old=observation(['navigation','Product A','10','Product B','10']);
 const changed=observation(['new navigation','extra navigation','Product A','20','Product B','10'],[[2,2],[4,2]]);
 assert.equal(unchangedLine(old,changed,'/textBlocks/line2').matched,false);
 const unchanged=unchangedLine(old,changed,'/textBlocks/line4');assert.equal(unchanged.matched,true);assert.equal(unchanged.value,'10');
 const fieldChanged=observation(['new navigation','extra navigation','Product A','10','Currency EUR'],[[2,3]]);
 assert.equal(unchangedLine(observation(['navigation','Product A','10','Currency USD']),fieldChanged,'/textBlocks/line2').matched,false,'Other changed fields in the same region are not ignored');
});
test('missing, tampered, ambiguous and non-text identities fail closed',()=>{
 const old=observation(['old navigation','Label','Value']),current=observation(['new navigation','extra','Label','Value'],[[2,2]]);
 assert.equal(unchangedLine(old,{...current,textRegions:[]},'/textBlocks/line2').matched,false);
 assert.equal(unchangedLine(old,{...current,textRegions:[{...current.textRegions[0],sha256:'forged'}]},'/textBlocks/line2').matched,false);
 assert.equal(unchangedLine(old,observation(['Label','Value','Label','Value'],[[0,2],[2,2]]),'/textBlocks/line2').matched,false);
 assert.equal(unchangedLine(old,current,'/controls/0/value').matched,false);
 assert.equal(unchangedLine(old,current,'/textBlocks/__proto__').matched,false);
 assert.equal(unchangedLine({screen:old},{screen:current},'/screen/textBlocks/line2').value,'Value');
});
