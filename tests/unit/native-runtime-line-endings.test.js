'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
test('native image source bytes stay LF-only across Windows and Linux releases',()=>{
  const attributes=fs.readFileSync(path.join(root,'.gitattributes'),'utf8');
  for(const file of ['codex-container.js','codex-models.js']){
    const relative='scripts/environment-agent-demo/'+file;
    assert.match(attributes,new RegExp(relative.replaceAll('.','\\.')+' text eol=lf'));
    const bytes=fs.readFileSync(path.join(root,relative));
    assert.equal(bytes.includes(Buffer.from('\r\n')),false,relative+' must match the immutable image bytes');
  }
});
