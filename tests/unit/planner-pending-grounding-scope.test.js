'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{groundedMoneyArguments}=require('../../src/assistant/postgres-capability-planner');
test('a new request cannot inherit delivery mode, unit price or date from an unrelated pending request',()=>{
 const step={contract:{name:'sales_order.create'},args:{amount:'44',orderDate:'2026-02-01'},continuesPending:false};
 groundedMoneyArguments([step],'Prepare a separate draft order at $12 each.',{originalMessage:'Prepare a pickup order dated 2026-02-01 at $44 each.'});
 assert.equal(step.args.deliveryMethod,undefined);assert.equal(step.args.amount,'12');assert.equal(step.args.orderDate,undefined);
});
test('an explicit pending continuation retains the original request evidence',()=>{
 const step={contract:{name:'sales_order.create'},args:{amount:'44'},continuesPending:true};
 groundedMoneyArguments([step],'Use the main counter.',{originalMessage:'Prepare a pickup order at $44 each.'});assert.equal(step.args.amount,'44');assert.equal(step.args.deliveryMethod,'pickup');
});
