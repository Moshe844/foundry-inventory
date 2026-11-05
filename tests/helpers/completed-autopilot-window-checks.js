'use strict';
const assert=require('node:assert/strict');
async function check(c,ctx,prefix){
 const find=require('../../src/operations/completed-autopilot-check').find,cutoff='2100-11-01T00:00:00.000Z';let statement;
 const measured={query:(sql,values)=>{statement=sql;return c.query(sql,values);}};
 assert.equal(await find(measured,ctx.workspaceId,cutoff),null);
 await c.query('ANALYZE stockchief_runtime.jobs');
 const literal=(await c.query('SELECT quote_literal($1::text) workspace,quote_literal($2::timestamptz) cutoff',[ctx.workspaceId,cutoff])).rows[0],plans=[];
 await c.query('PREPARE completed_autopilot_window(text,timestamptz) AS '+statement);
 try{for(const mode of ['force_custom_plan','force_generic_plan']){
  await c.query('SET LOCAL plan_cache_mode='+mode);
  const plan=(await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) EXECUTE completed_autopilot_window('+literal.workspace+','+literal.cutoff+')')).rows[0]['QUERY PLAN'][0],nodes=[];
  const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
  const scan=nodes.find(n=>n['Index Name']==='jobs_completed_autopilot_window');assert(scan,'Completed cycles must use the bounded date index in '+mode);
  assert.match(scan['Index Cond'],/completed_at/);assert.equal(scan['Actual Rows'],0);assert(!nodes.some(n=>n['Relation Name']==='jobs'&&n['Node Type']==='Seq Scan'));
  plans.push({mode,ms:plan['Execution Time'],oldRowsVisited:0});
 }}finally{await c.query('DEALLOCATE completed_autopilot_window');await c.query('SET LOCAL plan_cache_mode=auto');}
 await c.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,status,available_at,idempotency_key,result,created_at,completed_at,updated_at)
  SELECT $2||x.id,CASE WHEN x.id='foreign' THEN $2||'1' ELSE $1 END,x.kind,'COMPLETED',0,$2||x.id,x.result::jsonb,'2020-01-01',x.finished::timestamptz,x.finished::timestamptz FROM (VALUES
   ('old-start','autopilot.evaluate','{"partial":false,"cycleStartedAt":"2100-10-31T23:59:59.999Z"}','2100-11-02'),
   ('partial','autopilot.evaluate','{"partial":true,"cycleStartedAt":"2100-11-02T00:00:00Z"}','2100-11-03'),
   ('invalid','autopilot.evaluate','{"partial":false,"cycleStartedAt":"invalid legacy date"}','2100-11-04'),
   ('missing','autopilot.evaluate','{"partial":false}','2100-11-05'),
   ('foreign','autopilot.evaluate','{"partial":false,"cycleStartedAt":"2100-11-02T00:00:00Z"}','2100-11-06'),
   ('other-kind','fixture.other','{"partial":false,"cycleStartedAt":"2100-11-02T00:00:00Z"}','2100-11-07')
  )x(id,kind,result,finished)`,[ctx.workspaceId,prefix]);
 assert.equal(await find(c,ctx.workspaceId,cutoff),null,'Partial, old observations, foreign workspaces and invalid dates do not cover the request');
 await c.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,status,available_at,idempotency_key,result,created_at,completed_at,updated_at)
  VALUES($2,$1,'autopilot.evaluate','COMPLETED',0,$2,'{"partial":false,"cycleStartedAt":"2100-10-31T20:00:00-04:00"}','2020-01-01',$3,$3)`,[ctx.workspaceId,prefix+'boundary',cutoff]);
 assert.equal((await find(c,ctx.workspaceId,cutoff)).id,prefix+'boundary','A cycle queued earlier but observed exactly at the request boundary still covers it');
 await c.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,status,available_at,idempotency_key,result,created_at,completed_at,updated_at)
  VALUES($2,$1,'autopilot.evaluate','COMPLETED',0,$2,'{"partial":false,"cycleStartedAt":"2100-11-02T00:00:00Z"}','2020-01-01','2100-11-03','2100-11-03')`,[ctx.workspaceId,prefix+'latest']);
 assert.equal((await find(c,ctx.workspaceId,cutoff)).id,prefix+'latest');
 return {completedAutopilotWindowExact:true,completedAutopilotInvalidDateSafe:true,completedAutopilotPlans:plans};
}
module.exports={check};
