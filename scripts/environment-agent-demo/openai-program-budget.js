'use strict';
const {ExperimentBudget}=require('./budget');
const {createHash}=require('node:crypto');
const CEILING=100000000;
const PHASES=Object.freeze({core:{ceiling:75000000,attempts:100},repair:{ceiling:15000000,attempts:20},staging:{ceiling:10000000,attempts:10}});
// Durable phase/slot constraints live in SQLite, so a second process using the
// older budget client cannot evade them. This never approves or refills funds.
function configure(budget){
 budget.db.exec(`CREATE TABLE IF NOT EXISTS openai_program_phases (
  experiment TEXT NOT NULL,phase TEXT NOT NULL,ceiling INTEGER NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(experiment,phase));
 CREATE TABLE IF NOT EXISTS openai_program_slots (
  experiment TEXT NOT NULL,task TEXT NOT NULL,phase TEXT NOT NULL,source_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,
  PRIMARY KEY(experiment,task));
 CREATE TRIGGER IF NOT EXISTS openai_program_reservations BEFORE INSERT ON experiment_calls
 WHEN EXISTS(SELECT 1 FROM openai_program_phases WHERE experiment=NEW.experiment)
 BEGIN
  SELECT CASE WHEN NEW.candidate<>'openai' OR NOT EXISTS(SELECT 1 FROM openai_program_slots WHERE experiment=NEW.experiment AND task=NEW.task)
   THEN RAISE(ABORT,'UNAPPROVED_CERTIFICATION_SLOT') END;
  SELECT CASE WHEN NEW.reserved+(SELECT COALESCE(SUM(CASE WHEN c.state='SETTLED' THEN c.charged ELSE c.reserved END),0)
   FROM experiment_calls c JOIN openai_program_slots s ON c.experiment=s.experiment AND c.task=s.task
   WHERE c.experiment=NEW.experiment AND s.phase=(SELECT phase FROM openai_program_slots WHERE experiment=NEW.experiment AND task=NEW.task))>
   (SELECT ceiling FROM openai_program_phases WHERE experiment=NEW.experiment AND phase=(SELECT phase FROM openai_program_slots WHERE experiment=NEW.experiment AND task=NEW.task))
   THEN RAISE(ABORT,'CERTIFICATION_PHASE_CEILING') END;
 END;
 CREATE TRIGGER IF NOT EXISTS openai_program_slot_limit BEFORE INSERT ON openai_program_slots BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM openai_program_phases WHERE experiment=NEW.experiment AND phase=NEW.phase)
   OR (SELECT COUNT(*) FROM openai_program_slots WHERE experiment=NEW.experiment AND phase=NEW.phase)>=
    (SELECT attempts FROM openai_program_phases WHERE experiment=NEW.experiment AND phase=NEW.phase)
   THEN RAISE(ABORT,'CERTIFICATION_ATTEMPT_LIMIT') END;
 END;`);
 budget.transaction(()=>{for(const [phase,policy]of Object.entries(PHASES)){
  const prior=budget.db.prepare('SELECT ceiling,attempts FROM openai_program_phases WHERE experiment=? AND phase=?').get(budget.experiment,phase);
  if(prior&&(prior.ceiling!==policy.ceiling||prior.attempts!==policy.attempts))throw new Error('IMMUTABLE_PHASE_POLICY');
  if(!prior)budget.db.prepare('INSERT INTO openai_program_phases VALUES(?,?,?,?)').run(budget.experiment,phase,policy.ceiling,policy.attempts);
 }});
}
function register(budget,manifest){
 if(!PHASES[manifest.phase]||manifest.primary!=='openai'||!manifest.sourceHash||!Array.isArray(manifest.tasks)||!manifest.tasks.length)throw new Error('INVALID_COHORT');
 const hash=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
 budget.transaction(()=>{for(const task of manifest.tasks){
  if(!task.id.startsWith(manifest.phase+'--'))throw new Error('COHORT_TASK_PREFIX_REQUIRED');
  const previous=budget.db.prepare('SELECT * FROM openai_program_slots WHERE experiment=? AND task=?').get(budget.experiment,task.id);
  if(previous){if(previous.manifest_hash!==hash)throw new Error('IMMUTABLE_CERTIFICATION_SLOT');continue;}
  budget.db.prepare('INSERT INTO openai_program_slots VALUES(?,?,?,?,?)').run(budget.experiment,task.id,manifest.phase,manifest.sourceHash,hash);
 }});return hash;
}
function phaseStatus(budget,phase){
 const policy=PHASES[phase];if(!policy)throw new Error('INVALID_PHASE');
 const row=budget.db.prepare(`SELECT COALESCE(SUM(CASE WHEN c.state='SETTLED' THEN c.charged ELSE c.reserved END),0) committed
  FROM experiment_calls c JOIN openai_program_slots s ON c.experiment=s.experiment AND c.task=s.task WHERE c.experiment=? AND s.phase=?`).get(budget.experiment,phase);
 return {...policy,...row,remaining:Math.max(0,policy.ceiling-row.committed)};
}
function scoped(budget,phase){
 return new Proxy(budget,{get(target,key){
  if(key==='candidateStatus')return candidate=>{const state=target.candidateStatus(candidate),p=phaseStatus(target,phase);
   return {...state,remaining:Math.min(state.remaining,p.remaining)};};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
module.exports={ExperimentBudget,CEILING,PHASES,configure,register,phaseStatus,scoped};
