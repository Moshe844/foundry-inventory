'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),vm=require('node:vm');
const contract=require('../../scripts/environment-agent-demo/codex-image-contract');
test('sandbox certification rejects a stale baked compaction policy before a model request',()=>{
 const name='/opt/stockchief/codex-models.cjs',current=fs.readFileSync(path.join(__dirname,'../../scripts/environment-agent-demo/codex-models.js'));
 const expected={[name]:createHash('sha256').update(current).digest('hex')};
 const execute=bytes=>vm.runInNewContext(contract.probe(expected),{require,fs:{readFileSync(file){assert.equal(file,name);return bytes;}}});
 assert.doesNotThrow(()=>execute(current));
 assert.throws(()=>execute(Buffer.concat([current,Buffer.from('\n// previous release policy\n')])),/NATIVE_RUNTIME_SOURCE_MISMATCH/);
});
test('native image manifest covers every embedded release file and the installed SDK',()=>{
 const expected=contract.expectedFiles();assert.deepEqual(Object.keys(expected).sort(),['/opt/stockchief/codex-container.cjs','/opt/stockchief/codex-models.cjs','/opt/stockchief/codex-operator-instructions.txt','/opt/stockchief/codex-sdk.mjs']);
 assert(Object.values(expected).every(hash=>/^[a-f0-9]{64}$/.test(hash)));
 assert.throws(()=>contract.verifyFiles({'/workspace/agent.js':'a'.repeat(64)},()=>Buffer.from('')),/INVALID_NATIVE_RUNTIME_MANIFEST/);
});
