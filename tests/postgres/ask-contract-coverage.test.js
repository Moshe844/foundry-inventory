'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {registry,FIELDS}=require('../../src/assistant/postgres-capability-registry');
const {SPECS}=require('../../src/assistant/postgres-workflow-capabilities');
const {destinationById}=require('../../src/web/postgres-navigation');
const {RECORDS}=require('../../src/web/postgres-record-destinations');

test('every registered Ask contract has an executable, verified, permissioned implementation',()=>{
  const all=registry.list();
  assert.equal(new Set(all.map(contract=>contract.name)).size,all.length);
  const count=kind=>registry.list(kind).length;
  assert.ok(count('mutation')>=65,`Only ${count('mutation')} write contracts`);
  assert.ok(count('read')>=27,`Only ${count('read')} read contracts`);
  assert.ok(count('navigation')>=40,`Only ${count('navigation')} navigation contracts`);
  assert.ok(count('policy')>=1,'No governed policy contract');
  for(const contract of all){
    assert.equal(typeof contract.prepare,'function',`${contract.name} prepare`);
    assert.equal(typeof contract.verify,'function',`${contract.name} verify`);
    assert.equal(typeof contract.validate,'function',`${contract.name} validate`);
    assert.ok(contract.permission,`${contract.name} permission`);
    assert.ok(contract.description,`${contract.name} description`);
    assert.ok(contract.fields.every(field=>FIELDS[field]),`${contract.name} declared inputs`);
    if(contract.kind==='mutation'){
      assert.equal(contract.authority.mode,'explicit_approval',`${contract.name} approval`);
      assert.equal(typeof contract.execute,'function',`${contract.name} canonical executor`);
      assert.equal(typeof contract.verifyExecution,'function',`${contract.name} resulting-record verifier`);
      assert.ok(Object.hasOwn(contract,'commercialCapability'),`${contract.name} entitlement classification`);
    }
    if(contract.destinationId)assert.ok(destinationById(contract.destinationId),`${contract.name} live page`);
    if(contract.kind==='navigation'&&contract.recordKind)
      assert.ok(RECORDS[contract.recordKind],`${contract.name} live record destination`);
  }
  for(const spec of SPECS){
    const contract=registry.get(spec.name);
    assert.ok(contract,`${spec.name} missing from planner catalogue`);
    assert.equal(contract.execute,spec.execute,`${spec.name} must use the canonical engine`);
    assert.equal(contract.verifyExecution,spec.verify,`${spec.name} must verify the result`);
  }
});
