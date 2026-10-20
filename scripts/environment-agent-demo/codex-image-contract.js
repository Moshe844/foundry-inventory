'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function expectedFiles(){
 const sdk=require.resolve.paths('@openai/codex-sdk').map(base=>path.join(base,'@openai/codex-sdk/dist/index.js')).find(file=>fs.existsSync(file));
 if(!sdk)throw Error('INSTALLED_CODEX_SDK_REQUIRED');
 const files={
  '/opt/stockchief/codex-container.cjs':fs.readFileSync(path.join(__dirname,'codex-container.js')),
  '/opt/stockchief/codex-models.cjs':fs.readFileSync(path.join(__dirname,'codex-models.js')),
  '/opt/stockchief/codex-operator-instructions.txt':Buffer.from(require('./codex-operator-instructions')),
  '/opt/stockchief/codex-sdk.mjs':fs.readFileSync(sdk)
 };
 return Object.fromEntries(Object.entries(files).map(([file,bytes])=>[file,createHash('sha256').update(bytes).digest('hex')]));
}
// This function also runs in the immutable sandbox before it becomes a spare.
// Compare the real image bytes, including the baked model/compaction policy,
// with the current host release. A matching Docker ID alone is insufficient.
function verifyFiles(expected,readFile){
 const {createHash}=require('node:crypto');
 for(const [file,hash]of Object.entries(expected)){
  if(!/^\/opt\/stockchief\/[a-z-]+\.(?:cjs|mjs|txt)$/.test(file)||!/^[a-f0-9]{64}$/.test(hash))throw Error('INVALID_NATIVE_RUNTIME_MANIFEST');
  if(createHash('sha256').update(readFile(file)).digest('hex')!==hash)throw Error('NATIVE_RUNTIME_SOURCE_MISMATCH');
 }
}
function probe(expected){return `(${verifyFiles.toString()})(${JSON.stringify(expected)},file=>fs.readFileSync(file));`;}
module.exports={expectedFiles,verifyFiles,probe};
