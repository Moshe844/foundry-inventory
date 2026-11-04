'use strict';
const assert=require('node:assert/strict');
async function check(db,ctx){
 const summary=require('../../src/projections/postgres-home-summary'),since='2026-11-01T00:00:00.000Z';
 const before=await summary.activityCounts(db,ctx.workspaceId,since),prefix='home-window:'+ctx.workspaceId+':';
 await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,execution_status,approval_requirement,idempotency_key,created_at,completed_at)
  SELECT $2||n,$1,'history','home_window_fixture','{}','COMPLETED',CASE WHEN n%2=0 THEN 'NONE' ELSE 'REQUIRED' END,$2||n,'2020-01-01T00:00:00.000Z','2020-01-02T00:00:00.000Z' FROM generate_series(1,50000)n`,[ctx.workspaceId,prefix]);
 await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,execution_status,approval_requirement,idempotency_key,created_at,completed_at)
  SELECT $2||x.id,$1,'history','home_window_fixture','{}',x.status,x.approval,$2||x.id,x.created,x.completed FROM (VALUES
   ('boundary','COMPLETED','NONE','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'),
   ('old-created','COMPLETED','REQUIRED','2020-01-01T00:00:00.000Z','2026-10-31T20:00:00.000-04:00'),
   ('offset','WAITING_FOR_APPROVAL','REQUIRED','2026-10-31T20:00:00.000-04:00',NULL),
   ('before','COMPLETED','NONE','2026-10-31T23:59:59.999Z','2026-10-31T23:59:59.999Z'),
   ('warning','COMPLETED','REQUIRED_WITH_WARNING','2020-01-01T00:00:00.000Z','2026-11-01T00:00:00.000Z'),
   ('invalid','COMPLETED','NONE','invalid legacy date','invalid legacy date')
  )x(id,status,approval,created,completed)`,[ctx.workspaceId,prefix]);
 await db.query(`INSERT INTO attention_items(id,workspace_id,fingerprint,category,severity,title,concise_summary,explanation,recommendation,affected_entity_type,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at,resolved_at)
  SELECT $2||'finding:'||n,$1,$2||'finding:'||n,'history','watch','Old finding','Old finding','Old finding','No action','workspace','high','RESOLVED','fixture','2020-01-01T00:00:00.000Z','2020-01-02T00:00:00.000Z','2020-01-02T00:00:00.000Z' FROM generate_series(1,5000)n`,[ctx.workspaceId,prefix]);
 await db.query(`INSERT INTO attention_items(id,workspace_id,fingerprint,category,severity,title,concise_summary,explanation,recommendation,affected_entity_type,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at,resolved_at)
  SELECT $2||x.id,$1,$2||x.id,'history','watch','Recent finding','Recent finding','Recent finding','Review','workspace','high',x.status,'fixture',x.detected,x.detected,x.resolved FROM (VALUES
   ('found-boundary','OPEN','2026-11-01T00:00:00.000Z',NULL),
   ('resolved-offset','RESOLVED','2020-01-01T00:00:00.000Z','2026-10-31T20:00:00.000-04:00'),
   ('found-offset','OPEN','2026-10-31T20:00:00.000-04:00',NULL),
   ('finding-before','RESOLVED','2026-10-31T23:59:59.999Z','2026-10-31T23:59:59.999Z'),
   ('finding-invalid','RESOLVED','invalid legacy date','invalid legacy date')
  )x(id,status,detected,resolved)`,[ctx.workspaceId,prefix]);
 await db.query('ANALYZE work_items,attention_items');
 let statement;const captured={query:(sql,values)=>{statement=sql;return db.query(sql,values);}};
 const after=await summary.activityCounts(captured,ctx.workspaceId,since),expected={...before};
 for(const [key,delta]of Object.entries({alone:1,approved:2,proposed:2,found:2,resolved:1}))expected[key]+=delta;
 assert.deepEqual(after,expected,'Recent creation and completion are independent; offsets, boundaries and invalid old dates stay exact');
 const limits={idx_work_items_created_instant:after.proposed,idx_work_items_completed_instant:after.alone+after.approved,idx_attention_detected_instant:after.found,idx_attention_resolved_instant:after.resolved},plans=[];
 await db.transaction(async c=>{
  await c.query('PREPARE home_history_window(text,timestamptz) AS '+statement);
  try{const literal=(await c.query('SELECT quote_literal($1::text) workspace,quote_literal($2::timestamptz) cutoff',[ctx.workspaceId,since])).rows[0];
   for(const mode of ['force_custom_plan','force_generic_plan']){
    await c.query('SET LOCAL plan_cache_mode='+mode);
    const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE home_history_window('+literal.workspace+','+literal.cutoff+')')).rows[0]['QUERY PLAN'][0],nodes=[];const visit=n=>{nodes.push(n);for(const child of n.Plans||[])visit(child);};visit(plan.Plan);
    assert(!nodes.some(n=>['work_items','attention_items'].includes(n['Relation Name'])&&n['Node Type']==='Seq Scan'),'Home must not scan all old history in '+mode);
    for(const [index,limit]of Object.entries(limits)){const scan=nodes.find(n=>n['Index Name']===index);assert(scan,'Missing date-window index '+index+' in '+mode);assert.match(scan['Index Cond'],/stockchief_movement_instant/);assert(Number(scan['Actual Rows'])<=limit,index+' visited historical or another inventory\'s rows');}
    plans.push({mode,indexes:nodes.filter(n=>n['Index Name']).map(n=>n['Index Name']),executionMs:plan['Execution Time']});
   }
  }finally{await c.query('DEALLOCATE home_history_window');}
 },{isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:5000});
 return {oldWorkRows:50000,oldFindingRows:5000,counts:after,plans};
}
module.exports={check};
