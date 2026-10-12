'use strict';

// Host-owned experiment accounting. Never place this file or its database in an
// agent workspace. Business fixtures may be discarded; this ledger must survive.
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');

function integer(value,name){
  if(!Number.isSafeInteger(value)||value<0)throw new TypeError(`${name} must be nonnegative integer micro-USD.`);
  return value;
}
class ExperimentBudget {
  constructor(filename,experiment){
    if(!experiment)throw new TypeError('An experiment identity is required.');
    this.experiment=experiment;
    this.db=new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS experiment_budget (
        id TEXT PRIMARY KEY, ceiling INTEGER NOT NULL DEFAULT 0,
        approval TEXT, expires INTEGER NOT NULL DEFAULT 0, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS experiment_calls (
        id TEXT PRIMARY KEY, experiment TEXT NOT NULL, candidate TEXT NOT NULL,
        task TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER,
        state TEXT NOT NULL, detail TEXT, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS experiment_calls_budget ON experiment_calls(experiment);
      CREATE TABLE IF NOT EXISTS experiment_allocations (
        experiment TEXT NOT NULL, candidate TEXT NOT NULL, ceiling INTEGER NOT NULL,
        PRIMARY KEY(experiment,candidate));`);
    this.db.prepare('INSERT OR IGNORE INTO experiment_budget(id) VALUES(?)').run(experiment);
  }
  transaction(fn){
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  // Called by a trusted operator ONLY after explicit user approval. There is no
  // command-line default, environment-variable bypass, or automatic refill.
  approve({ceilingMicroUsd,approvalReference,expiresAt,allocations=null}){
    integer(ceilingMicroUsd,'ceiling');
    const expires=Date.parse(expiresAt);
    if(!approvalReference||!Number.isFinite(expires)||expires<=Date.now())throw new Error('Explicit current approval required.');
    if(allocations!==null){
      if(!Array.isArray(allocations)||!allocations.length)throw new Error('INVALID_CANDIDATE_ALLOCATIONS');
      const names=new Set();let total=0;
      for(const a of allocations){
        if(typeof a.candidate!=='string'||!a.candidate.trim()||names.has(a.candidate)||!Number.isSafeInteger(a.ceilingMicroUsd)||a.ceilingMicroUsd<=0)
          throw new Error('INVALID_CANDIDATE_ALLOCATIONS');
        names.add(a.candidate);total+=a.ceilingMicroUsd;
      }
      if(!Number.isSafeInteger(total)||total!==ceilingMicroUsd)throw new Error('ALLOCATION_TOTAL_MUST_EQUAL_CEILING');
    }
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT * FROM experiment_budget WHERE id=?').get(this.experiment);
      if(prior.approval)throw new Error('Budget approval is immutable; do not reset an experiment to refill it.');
      this.db.prepare('UPDATE experiment_budget SET ceiling=?,approval=?,expires=? WHERE id=?')
        .run(ceilingMicroUsd,approvalReference,expires,this.experiment);
      for(const a of allocations||[])this.db.prepare('INSERT INTO experiment_allocations(experiment,candidate,ceiling) VALUES(?,?,?)')
        .run(this.experiment,a.candidate,a.ceilingMicroUsd);
      return this.status();
    });
  }
  status(){
    const policy=this.db.prepare('SELECT * FROM experiment_budget WHERE id=?').get(this.experiment);
    const usage=this.db.prepare(`SELECT COALESCE(sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END),0) AS committed,
      count(*) AS calls, sum(CASE WHEN state IN ('RESERVED','UNKNOWN') THEN 1 ELSE 0 END) AS unresolved
      FROM experiment_calls WHERE experiment=?`).get(this.experiment);
    return {...policy,...usage,remaining:Math.max(0,policy.ceiling-usage.committed)};
  }
  candidateStatus(candidate){
    const shared=this.status();
    const allocations=this.db.prepare('SELECT candidate,ceiling FROM experiment_allocations WHERE experiment=?').all(this.experiment);
    if(!allocations.length)return shared; // Preserve old, immutable experiment policies.
    const allocation=allocations.find(a=>a.candidate===candidate);
    if(!allocation)throw new Error('CANDIDATE_NOT_ALLOCATED');
    const usage=this.db.prepare(`SELECT COALESCE(sum(CASE WHEN state='SETTLED' THEN charged ELSE reserved END),0) AS committed,
      count(*) AS calls, COALESCE(sum(CASE WHEN state IN ('RESERVED','UNKNOWN') THEN 1 ELSE 0 END),0) AS unresolved
      FROM experiment_calls WHERE experiment=? AND candidate=?`).get(this.experiment,candidate);
    return {...shared,...usage,ceiling:allocation.ceiling,remaining:Math.min(shared.remaining,Math.max(0,allocation.ceiling-usage.committed)),
      candidate,sharedCeiling:shared.ceiling,sharedRemaining:shared.remaining,sharedUnresolved:shared.unresolved};
  }
  reserve({candidate,task,upperBoundMicroUsd}){
    integer(upperBoundMicroUsd,'upper bound');
    if(!candidate||!task||upperBoundMicroUsd===0)throw new Error('A priced candidate and task are required.');
    return this.transaction(()=>{
      const state=this.status();
      if(!state.approval||state.expires<=Date.now()||state.stopped)throw new Error('PAID_TESTING_LOCKED');
      // Serialize ALL candidates, internal calls, graders and retries, including
      // other processes. Unknown calls never free their reservation.
      if(state.unresolved)throw new Error('UNRESOLVED_MODEL_CALL');
      if(upperBoundMicroUsd>state.remaining)throw new Error('SHARED_SPENDING_CEILING');
      if(upperBoundMicroUsd>this.candidateStatus(candidate).remaining)throw new Error('CANDIDATE_SPENDING_CEILING');
      const id=randomUUID();
      this.db.prepare(`INSERT INTO experiment_calls(id,experiment,candidate,task,reserved,state,created)
        VALUES(?,?,?,?,?,'RESERVED',?)`).run(id,this.experiment,candidate,task,upperBoundMicroUsd,Date.now());
      return id;
    });
  }
  settle(id,actualMicroUsd,detail={}){
    integer(actualMicroUsd,'actual charge');
    const result=this.transaction(()=>{
      const call=this.db.prepare('SELECT * FROM experiment_calls WHERE id=? AND experiment=?').get(id,this.experiment);
      if(!call)throw new Error('Unknown reservation.');
      if(call.state==='ASSUMED_FULL')throw new Error('Conservative operator charge is final; it cannot be refunded.');
      if(call.state==='SETTLED'){
        if(call.charged!==actualMicroUsd)throw new Error('Conflicting settlement.');
        return;
      }
      this.db.prepare("UPDATE experiment_calls SET state='SETTLED',charged=?,detail=? WHERE id=?")
        .run(actualMicroUsd,JSON.stringify(detail),id);
      if(actualMicroUsd>call.reserved){
        this.db.prepare('UPDATE experiment_budget SET stopped=1 WHERE id=?').run(this.experiment);
        return 'PRICE_BOUND_VIOLATION';
      }
    });
    if(result)throw new Error(result);
  }
  unknown(id,reason){
    this.db.prepare("UPDATE experiment_calls SET state='UNKNOWN',detail=? WHERE id=? AND experiment=? AND state='RESERVED'")
      .run(JSON.stringify({reason}),id,this.experiment);
  }
  stop(){this.db.prepare('UPDATE experiment_budget SET stopped=1 WHERE id=?').run(this.experiment);}
  // Trusted operator reconciliation only; never invoked by the relay or SDK.
  // Resolve maximum financial exposure by permanently charging the entire
  // reservation. This does NOT claim a vendor receipt or free any money.
  accountUnknownAtMaximum(id,{evidenceReference,acknowledgeUnverifiedCharge=false}={}){
    if(!acknowledgeUnverifiedCharge||!evidenceReference)throw new Error('Explicit conservative reconciliation evidence required.');
    return this.transaction(()=>{
      const call=this.db.prepare('SELECT * FROM experiment_calls WHERE experiment=? AND id=?').get(this.experiment,id);
      if(!call||call.state!=='UNKNOWN')throw new Error('Only an unknown reservation can be conservatively accounted.');
      this.db.prepare("UPDATE experiment_calls SET state='ASSUMED_FULL',charged=reserved,detail=? WHERE id=?")
        .run(JSON.stringify({prior:JSON.parse(call.detail||'{}'),accounting:'full reservation permanently counted; provider invoice unverified',
          evidenceReference,reconciledAt:new Date().toISOString()}),id);
      return this.status();
    });
  }
  close(){if(this.db.isOpen)this.db.close();}
}
module.exports={ExperimentBudget};
