'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{present}=require('../../src/imports/postgres-progress');

// Until the worker writes its first progress, the saved checkpoint names the
// step that is running. A product import never shows "saving" before preparing.
test('a running import shows its real first step before the worker reports progress',()=>{
 const base={id:'first',records_detected:50000,records_valid:50000,plan_status:'EXECUTING',approval_status:'APPROVED',job_status:'RUNNING',lease_expires_at:2000,database_now:1000,integrity_hash:'approved'};
 const fresh=present(base);assert.equal(fresh.state,'RUNNING');assert.equal(fresh.stage,'preparing');assert.equal(fresh.stageLabel,'Preparing approved records');assert.equal(fresh.processedRows,null);
 const started=present({...base,apply_checkpoint:{hash:'approved',catalogueStarted:true,skusCreated:500}});assert.equal(started.stage,'preparing');
 const saving=present({...base,apply_checkpoint:{hash:'approved',cataloguePrepared:true,savedRows:4000}});assert.equal(saving.stage,'processing');assert.equal(saving.stageLabel,'Applying products, stock and costs');
 const otherApproval=present({...base,apply_checkpoint:{hash:'older',cataloguePrepared:true,savedRows:4000}});assert.equal(otherApproval.stage,'preparing');
 assert.equal(present({...base,dataset:'suppliers'}).stage,'processing','supplier files have no catalogue step');
 const reported=present({...base,job_result:{importProgress:{stage:'verifying',processedRows:50000,totalRows:50000,attempt:1}}});assert.equal(reported.stage,'verifying','a written progress stage always wins');
});
