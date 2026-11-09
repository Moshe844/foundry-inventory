'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowance, permits, requireJob } = require('../../src/commercial/agent-plan');

// Vector legend in the printed row order, pages 2–9. Keeping expectations
// independent of the runtime JSON catches a single changed plan cell.
const columns = {
  starter: 'AASS----S---S-A-SAD-SSS----D---SDA-----S---S---------S---SDA---S----A-------S-SS-A--SS-S-SS------DS------A-S-S-----SAS-------S------D---------SS---S--AAAAAA---AAS---AAAA---AAA---A-AS--------A-A-A--AAA-----AA-------',
  growth: 'AAAD--T-DA--DTADAATATSTT--TATA-ADAADD-AAA-DA-DTT-DTDTASTTTAA-A-D--TDAD-T-TDAS-DATA--ADAATAAD---TSDA-TTTDSA-ASATT-D-AAT-TD-AA-DDDDDA-AA-DDAD-DASA-SSAADAAAAAAAA-AAAA-AAAAAA--AAA-DDAAAAD--DD--DADAAADDAAAAAAA-AAAAAA---',
  pro: 'AAAATAAATATTAAAAAAAAATAAT-AAAATAAAAAATAAATAATAAATAAAAAAAAAAATATAT-AAAATATAAADTAAAATAADAAAAAATDTAAAATAAAAAADAAAAATATAAAAAADAA-TAAAAATAATAAAADAAAADAAAAAAAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAATAAAA-AAAAAAAAAAAAAAAAAAAAAAAA-',
  enterprise: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAADAAAAAAATAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const modes = { A:'alone', T:'trained', D:'draft', S:'suggest', '-':'excluded' };
for (const [plan, column] of Object.entries(columns)) {
  test(plan + ' matches all 214 agent jobs and their maximum authority', () => {
    assert.equal(column.length, 214);
    for (const [i, symbol] of [...column].entries()) {
      const id=i+1, effective=plan==='starter'&&[35,60].includes(id)?'D':plan==='growth'&&id===213?'T':symbol, label=`${plan} job ${id}`, facts={ edi:true };
      assert.equal(allowance(plan,id), modes[effective],label);
      assert.equal(permits(plan,id,'suggest',facts),effective!=='-',label);
      assert.equal(permits(plan,id,'draft',facts),'ADT'.includes(effective),label);
      assert.equal(permits(plan,id,'automatic',facts),effective==='A',label);
      assert.equal(permits(plan,id,'automatic',{edi:true,trained:true}),'AT'.includes(effective),label);
    }
  });
}
test('unknown jobs, modes, plans and unpaid Pro EDI fail closed', () => {
  for (const plan of [null,'free','constructor','__proto__']) assert.equal(permits(plan,1,'suggest'), false);
  assert.throws(()=>requireJob('pro',215,'automatic'));
  assert.throws(()=>requireJob('pro',185,'automatic'));
  assert.throws(()=>requireJob('growth',119,'automatic'), /Pro/);
  assert.equal(permits('enterprise',185,'automatic'),true);
  assert.equal(permits('enterprise',1,'invented'),false);
});
