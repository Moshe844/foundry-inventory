'use strict';
class PilotJournal{
 constructor(budget,manifest){this.budget=budget;this.db=budget.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS pilot_manifest(experiment TEXT PRIMARY KEY,manifest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS pilot_attempts(experiment TEXT NOT NULL,task TEXT NOT NULL,candidate TEXT NOT NULL,
   state TEXT NOT NULL,started INTEGER NOT NULL,result TEXT,PRIMARY KEY(experiment,task,candidate));`);
  budget.transaction(()=>{const previous=this.db.prepare('SELECT manifest FROM pilot_manifest WHERE experiment=?').get(budget.experiment);
   const packed=JSON.stringify(manifest);if(previous&&previous.manifest!==packed)throw new Error('PILOT_MANIFEST_CHANGED');
   this.db.prepare('INSERT OR IGNORE INTO pilot_manifest VALUES(?,?)').run(budget.experiment,packed);});
 }
 begin(task,candidate){return this.budget.transaction(()=>{
  if(this.db.prepare('SELECT 1 FROM pilot_attempts WHERE experiment=? AND state=?').get(this.budget.experiment,'RUNNING'))throw new Error('PILOT_ATTEMPT_UNRESOLVED');
  this.db.prepare('INSERT INTO pilot_attempts VALUES(?,?,?,\'RUNNING\',?,NULL)').run(this.budget.experiment,task,candidate,Date.now());
 });}
 finish(task,candidate,result){this.db.prepare('UPDATE pilot_attempts SET state=\'FINISHED\',result=? WHERE experiment=? AND task=? AND candidate=? AND state=\'RUNNING\'')
  .run(JSON.stringify(result),this.budget.experiment,task,candidate);}
 rows(){return this.db.prepare('SELECT * FROM pilot_attempts WHERE experiment=? ORDER BY started').all(this.budget.experiment).map(r=>({...r,result:r.result?JSON.parse(r.result):null}));}
}
module.exports={PilotJournal};
