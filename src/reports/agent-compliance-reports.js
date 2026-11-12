'use strict';

// Job 197: prepares audit and compliance reports.
//
// One report covers a period and is built only from recorded data:
//  - lot traceability: every movement of a batch, where it came from and went;
//  - recalls: each recall decision with who, when and why, and the customers
//    who received each recalled batch;
//  - expiry write-offs: expired batches taken out of stock, by whom and why;
//  - stock adjustments: count corrections and write-offs with who and why;
//  - stocktake sign-off: signed-off yearly stocktakes and approved counts;
//  - quality checks: delivery inspections and their write-offs. StockChief
//    keeps no temperature log, so the report says so instead of inventing one.
// The report freezes what it found, so a finalized report never changes. It
// downloads as Excel or PDF through the existing export code.
//
// Growth drafts each report for a person to finalize. Pro and Custom produce
// reports on the owner's weekly or monthly schedule on their own. A stock
// removal with no recorded reason is missing a fact, so that report waits for
// a person on every plan. Shadow mode, pause, watch mode, Watch only, Ask me
// first and Handle routine work being off also leave the report as a draft.

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const time=require('../lib/business-time');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=197,ACTION='report.compliance',kind='agent.compliance-reports.v1',path='/autopilot/compliance-reports',LIMIT=5000;
const reports='stockchief_runtime.agent_compliance_reports',schedules='stockchief_runtime.agent_compliance_schedules';
const SECTIONS=[['traceability','Lot traceability'],['recalls','Recalls'],['expiry','Expiry write-offs'],['adjustments','Stock adjustments'],
  ['stocktake','Stocktake sign-off'],['quality','Quality checks']];
const COLUMNS=['When','Item','Lot','Location','Quantity','Person','Detail','Reference'];
// Stock removals that are not sales, supplier returns, production or moves.
const WRITE_OFFS=`('damaged','damage','expired','disposal','loss','lost','scrap','write_off','shrink','theft')`;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const isDay=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can prepare compliance reports.');
}
async function access(db,ctx,{lock=false}={}){
  await owner(db,ctx,{lock});
  return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
}

// Rows for one section, in the report's shared columns.
async function section(db,workspaceId,key,{from,to,zone}){
  const at=column=>`to_char((${column})::timestamptz AT TIME ZONE $4,'YYYY-MM-DD HH24:MI')`;
  const args=[workspaceId,from,to,zone,LIMIT+1];
  const q=async sql=>(await db.query(sql,args)).rows;
  if(key==='traceability'){
    const rows=await q(`SELECT * FROM (
        SELECT m.occurred_at::timestamptz AS sort,m.id,${at('m.occurred_at')} AS "When",s.code AS item,l.code AS lot,loc.name AS location,m.quantity_delta::text AS quantity,
          u.name AS person,m.operation,m.leg,m.reason_code,m.reference,cp.name AS counterparty,c.name AS customer,o.order_number
        FROM movements m JOIN lots l ON l.workspace_id=m.workspace_id AND l.id=m.lot_id
        JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN locations loc ON loc.workspace_id=m.workspace_id AND loc.id=m.location_id
        LEFT JOIN locations cp ON cp.workspace_id=m.workspace_id AND cp.id=m.counterparty_location_id
        LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
        LEFT JOIN LATERAL(SELECT v.cost_source_record_id FROM accounting_inventory_cost_movements v WHERE v.workspace_id=m.workspace_id AND v.inventory_movement_id=m.id
          AND v.cost_source_type IN ('sales_order_fulfillment','sales_order_kit_fulfillment') LIMIT 1) v ON true
        LEFT JOIN sales_orders o ON o.workspace_id=m.workspace_id AND o.id=v.cost_source_record_id LEFT JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
        WHERE m.workspace_id=$1 AND m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz
        UNION ALL
        SELECT m.occurred_at::timestamptz,m.id,${at('m.occurred_at')},s.code,l.code,loc.name,(sign(m.quantity_delta)*count(*))::text,u.name,m.operation,m.leg,m.reason_code,m.reference,cp.name,NULL,NULL
        FROM movements m JOIN stockchief_runtime.inventory_movement_serial_units x ON x.workspace_id=m.workspace_id AND x.movement_id=m.id
        JOIN serial_units su ON su.workspace_id=m.workspace_id AND su.id=x.serial_unit_id JOIN lots l ON l.workspace_id=su.workspace_id AND l.id=su.lot_id
        JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN locations loc ON loc.workspace_id=m.workspace_id AND loc.id=m.location_id
        LEFT JOIN locations cp ON cp.workspace_id=m.workspace_id AND cp.id=m.counterparty_location_id
        LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
        WHERE m.workspace_id=$1 AND m.lot_id IS NULL AND m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz
        GROUP BY m.id,m.occurred_at,s.code,l.code,loc.name,m.quantity_delta,u.name,m.operation,m.leg,m.reason_code,m.reference,cp.name) x
      WHERE $4::text IS NOT NULL ORDER BY sort,id LIMIT $5`);
    return rows.map(r=>({When:r.When,Item:r.item,Lot:r.lot,Location:r.location,Quantity:r.quantity,Person:r.person||'Former team member',
      Detail:r.operation==='receive'?'Received':r.operation==='transfer'?(r.leg==='out'?'Sent to '+(r.counterparty||'another location'):'Arrived from '+(r.counterparty||'another location')):
        r.operation==='adjust'?'Count correction':r.customer?'Shipped to '+r.customer:r.reason_code==='sale'?'Sold':'Taken out'+(r.reason_code?': '+r.reason_code.replace(/_/g,' '):''),
      Reference:r.order_number||r.reference||''}));
  }
  if(key==='recalls'){
    const decisions=await q(`SELECT ${at('e.occurred_at')} AS "When",s.code AS item,l.code AS lot,u.name AS person,e.held,e.reason,e.revision,l.recalled_at IS NOT NULL AS recalled
      FROM stockchief_runtime.lot_recall_events e JOIN lots l ON l.workspace_id=e.workspace_id AND l.id=e.lot_id
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id LEFT JOIN users u ON u.id=e.actor_id
      WHERE e.workspace_id=$1 AND e.occurred_at>=$2::timestamptz AND e.occurred_at<$3::timestamptz AND $4::text IS NOT NULL
      ORDER BY e.occurred_at,e.id LIMIT $5`);
    const rows=decisions.map(r=>({When:r.When,Item:r.item,Lot:r.lot,Location:'',Quantity:'',Person:r.person||'Former team member',
      Detail:(r.held?'Recall placed: ':'Recall released: ')+r.reason,Reference:'Revision '+r.revision}));
    // Who received each batch recalled in this period.
    const trace=require('../autopilot/traceability-reviews').find(d=>d.id===193).sql;
    for(const lot of [...new Set(decisions.filter(d=>d.held).map(d=>d.lot))].slice(0,50)){
      for(const r of (await db.query(trace+' LIMIT 500',[workspaceId,lot])).rows)
        rows.push({When:'',Item:r.SKU,Lot:r.Lot,Location:'',Quantity:String(r['Units issued']),Person:'',Detail:'Received by '+r.Customer+' ('+r.Type.toLowerCase()+')',Reference:r.Order});
    }
    return rows;
  }
  if(key==='expiry'){
    return (await q(`SELECT ${at('m.occurred_at')} AS "When",s.code AS "Item",l.code AS "Lot",loc.name AS "Location",m.quantity_delta::text AS "Quantity",
        coalesce(u.name,'Former team member') AS "Person",
        'Written off'||coalesce(' ('||replace(m.reason_code,'_',' ')||')','')||', expired on '||l.expires_at::date::text||coalesce('. '||nullif(m.notes,''),'') AS "Detail",
        coalesce(m.reference,'') AS "Reference",m.reason_code IS NULL AS gap
      FROM movements m JOIN lots l ON l.workspace_id=m.workspace_id AND l.id=m.lot_id JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
      JOIN locations loc ON loc.workspace_id=m.workspace_id AND loc.id=m.location_id LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
      WHERE m.workspace_id=$1 AND m.operation='issue' AND m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz
        AND l.expires_at IS NOT NULL AND l.expires_at::date<=(m.occurred_at::timestamptz AT TIME ZONE $4)::date
        AND (m.reason_code IS NULL OR m.reason_code IN ${WRITE_OFFS})
      ORDER BY m.occurred_at,m.id LIMIT $5`));
  }
  if(key==='adjustments'){
    return (await q(`SELECT * FROM (
        SELECT a.created_at::timestamptz AS sort,a.id,${at('a.created_at')} AS "When",s.code AS "Item",coalesce(l.code,'') AS "Lot",loc.name AS "Location",
          (a.counted_qty-a.expected_qty)::text AS "Quantity",coalesce(u.name,'Former team member') AS "Person",
          'Counted '||a.counted_qty||', expected '||a.expected_qty||'. Reason: '||replace(a.reason_code,'_',' ')||coalesce('. '||nullif(a.notes,''),'') AS "Detail",'' AS "Reference",false AS gap
        FROM adjustments a JOIN skus s ON s.workspace_id=a.workspace_id AND s.id=a.sku_id JOIN locations loc ON loc.workspace_id=a.workspace_id AND loc.id=a.location_id
        LEFT JOIN lots l ON l.workspace_id=a.workspace_id AND l.id=a.lot_id LEFT JOIN users u ON u.workspace_id=a.workspace_id AND u.id=a.actor_user_id
        WHERE a.workspace_id=$1 AND a.created_at::timestamptz>=$2::timestamptz AND a.created_at::timestamptz<$3::timestamptz
        UNION ALL
        SELECT m.occurred_at::timestamptz,m.id,${at('m.occurred_at')},s.code,coalesce(l.code,''),loc.name,m.quantity_delta::text,coalesce(u.name,'Former team member'),
          CASE WHEN m.reason_code IS NULL THEN 'Taken out with no recorded reason' ELSE 'Taken out. Reason: '||replace(m.reason_code,'_',' ') END||coalesce('. '||nullif(m.notes,''),''),
          coalesce(m.reference,''),m.reason_code IS NULL
        FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN locations loc ON loc.workspace_id=m.workspace_id AND loc.id=m.location_id
        LEFT JOIN lots l ON l.workspace_id=m.workspace_id AND l.id=m.lot_id LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
        WHERE m.workspace_id=$1 AND m.operation='issue' AND m.occurred_at::timestamptz>=$2::timestamptz AND m.occurred_at::timestamptz<$3::timestamptz
          AND (m.reason_code IN ${WRITE_OFFS} OR (m.reason_code IS NULL AND NOT EXISTS(SELECT 1 FROM accounting_inventory_cost_movements v
            WHERE v.workspace_id=m.workspace_id AND v.inventory_movement_id=m.id)))) x
      WHERE $4::text IS NOT NULL ORDER BY sort,id LIMIT $5`));
  }
  if(key==='stocktake'){
    return (await q(`SELECT * FROM (
        SELECT p.signed_off_at AS sort,p.id,${at('p.signed_off_at')} AS "When",'' AS "Item",'' AS "Lot",'' AS "Location",'' AS "Quantity",
          coalesce(u.name,'Former team member') AS "Person",'Yearly stocktake signed off: '||p.title AS "Detail",p.stocktake_year::text AS "Reference"
        FROM stockchief_runtime.agent_annual_stocktakes p LEFT JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.signoff->>'ownerId'
        WHERE p.workspace_id=$1 AND p.status='SIGNED_OFF' AND p.signed_off_at>=$2::timestamptz AND p.signed_off_at<$3::timestamptz
        UNION ALL
        SELECT r.approved_at,r.id,${at('r.approved_at')},'','',coalesce(r.payload->'location'->>'name',''),jsonb_array_length(r.payload->'lines')::text,
          coalesce(u.name,'Former team member'),'Count approved: '||jsonb_array_length(r.payload->'lines')||CASE WHEN jsonb_array_length(r.payload->'lines')=1 THEN ' line' ELSE ' lines' END,coalesce(r.payload->>'reference','')
        FROM physical_count_reviews r LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.approved_by_user_id
        WHERE r.workspace_id=$1 AND r.status='COMPLETED' AND r.approved_at>=$2::timestamptz AND r.approved_at<$3::timestamptz) x
      WHERE $4::text IS NOT NULL ORDER BY sort,id LIMIT $5`));
  }
  return (await q(`SELECT * FROM (
      SELECT h.inspected_at AS sort,h.id,${at('h.inspected_at')} AS "When",s.code AS "Item",'' AS "Lot",loc.name AS "Location",h.quantity::text AS "Quantity",
        coalesce(u.name,'Former team member') AS "Person",
        CASE WHEN h.status='FAILED' THEN 'Inspection failed' ELSE 'Inspection passed' END||coalesce(': '||nullif(h.inspection->>'note',''),'') AS "Detail",'' AS "Reference"
      FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
      JOIN locations loc ON loc.workspace_id=h.workspace_id AND loc.id=h.location_id LEFT JOIN users u ON u.workspace_id=h.workspace_id AND u.id=h.inspected_by
      WHERE h.workspace_id=$1 AND h.inspected_at>=$2::timestamptz AND h.inspected_at<$3::timestamptz
      UNION ALL
      SELECT w.created_at,w.id,${at('w.created_at')},s.code,'',loc.name,(-w.quantity)::text,coalesce(u.name,'Former team member'),'Failed goods written off: '||w.note,''
      FROM stockchief_runtime.agent_quality_writeoffs w JOIN stockchief_runtime.agent_quality_holds h ON h.workspace_id=w.workspace_id AND h.id=w.hold_id
      JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN locations loc ON loc.workspace_id=h.workspace_id AND loc.id=h.location_id
      LEFT JOIN users u ON u.workspace_id=w.workspace_id AND u.id=w.approved_by
      WHERE w.workspace_id=$1 AND w.created_at>=$2::timestamptz AND w.created_at<$3::timestamptz) x
    WHERE $4::text IS NOT NULL ORDER BY sort,id LIMIT $5`));
}

const notes={quality:'StockChief keeps no temperature log. Quality checks come from delivery inspections.'};

// Everything the report found for its period, frozen.
async function build(db,workspaceId,{start,end}){
  const {timeZone:zone}=await time.forWorkspace(db,workspaceId);
  const bounds={from:time.dayBoundary(start,zone),to:time.dayBoundary(end,zone,{nextDay:true}),zone};
  const sections=[],gaps=[];
  for(const [key,label] of SECTIONS){
    const found=await section(db,workspaceId,key,bounds);
    const rows=found.slice(0,LIMIT).map(r=>Object.fromEntries(COLUMNS.map(c=>[c,r[c]==null?'':String(r[c])])));
    const missing=found.slice(0,LIMIT).filter(r=>r.gap).length;
    if(missing)gaps.push(label+': '+missing+(missing===1?' stock removal has':' stock removals have')+' no recorded reason.');
    if(found.length>LIMIT)gaps.push(label+': more than '+LIMIT.toLocaleString('en-US')+' records. Choose a shorter period.');
    sections.push({key,label,rows,note:notes[key]||null});
  }
  return {period:{start,end},timeZone:zone,sections,gaps,generatedAt:new Date().toISOString()};
}

function period(input){
  const start=String(input.from||'').trim(),end=String(input.to||'').trim();
  if(!isDay(start)||!isDay(end))throw new ValidationError('Choose a start and an end date.');
  if(end<start)throw new ValidationError('The end date comes before the start date.');
  if(Date.parse(end)-Date.parse(start)>366*86400000)throw new ValidationError('Choose a period of up to one year.');
  return {start,end};
}

async function save(c,ctx,{key,span,content,status,reason=null,wouldFinalize=false,automatic=false,scheduled=false,preparedBy=null,finalizedBy=null}){
  const id=newId('compliance-report'),body=JSON.stringify(content);
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'compliance-report:'+id,Buffer.byteLength(body)*2+4096,{finished:true});
  await c.query(`INSERT INTO ${reports}(id,workspace_id,request_key,period_start,period_end,status,content,content_hash,gaps,reason,would_finalize,automatic,scheduled,prepared_by,finalized_by,finalized_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $6='FINAL' THEN clock_timestamp() END)`,
  [id,ctx.workspaceId,key,span.start,span.end,status,body,hash(content),content.gaps.length,reason,wouldFinalize,automatic,scheduled,preparedBy,finalizedBy]);
  const counts=Object.fromEntries(content.sections.map(s=>[s.key,s.rows.length]));
  await audit.record(c,ctx,{action:status==='FINAL'?(automatic?'Compliance report produced on its own':'Compliance report finalized'):'Compliance report drafted',
    reference:id,after:{from:span.start,to:span.end,rows:counts,gaps:content.gaps.length,reason}});
  return {id,status};
}

// A person prepares a report for a period. Growth gets a draft to finalize;
// Pro and Custom finalize it at once unless facts are missing.
async function prepare(database,ctx,input={}){
  const span=period(input),requestKey=String(input.requestKey||'').trim();
  if(!requestKey||requestKey.length>200)throw new ValidationError('Reload the page before preparing a report.');
  return tx(database,async c=>{
    const state=await access(c,ctx,{lock:true});
    const prior=(await c.query(`SELECT id,status FROM ${reports} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,'manual:'+requestKey])).rows[0];
    if(prior)return {...prior,replayed:true};
    const content=await build(c,ctx.workspaceId,span);
    const alone=policy.permits(state.plan,JOB,'automatic');
    const reason=content.gaps.length?'Some facts are missing. Check them before you finalize.':alone?null:'A person finalizes each report on this plan.';
    return save(c,ctx,{key:'manual:'+requestKey,span,content,status:reason?'DRAFT':'FINAL',reason,preparedBy:ctx.actorId,finalizedBy:reason?null:ctx.actorId});
  });
}

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT r.*,r.period_start::text AS period_start,r.period_end::text AS period_end,p.name AS prepared_name,f.name AS finalized_name
    FROM ${reports} r LEFT JOIN users p ON p.id=r.prepared_by LEFT JOIN users f ON f.id=r.finalized_by
    WHERE r.workspace_id=$1 AND r.id=$2${lock?' FOR UPDATE OF r':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That compliance report is not in this inventory.');
  return row;
}

// A person finalizes the exact draft they reviewed.
async function finalize(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const r=await load(c,ctx,id,{lock:true});
    if(r.status==='FINAL'&&input.hash===r.content_hash)return {replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('This report is no longer a draft.');
    if(input.confirmed!=='yes'||input.hash!==r.content_hash)throw new ValidationError('Review this report and confirm it before finalizing.');
    await c.query(`UPDATE ${reports} SET status='FINAL',finalized_by=$3,finalized_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Compliance report finalized',reference:r.id,after:{from:r.period_start,to:r.period_end,gaps:r.gaps,automaticDraft:r.automatic}});
    return {finalized:true};
  });
}
async function discard(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const r=await load(c,ctx,id,{lock:true});
    if(r.status==='DISCARDED')return {replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('A finalized report is kept as it is.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this draft is discarded.');
    await c.query(`UPDATE ${reports} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    await audit.record(c,ctx,{action:'Compliance report draft discarded',reference:r.id,after:{from:r.period_start,to:r.period_end}});
    return {discarded:true};
  });
}

// The owner's weekly or monthly schedule. It counts as a saved rule.
async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const prior=(await c.query(`SELECT * FROM ${schedules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(input.revision!=null&&input.revision!==''&&Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current schedule.');
    if(input.stop==='yes'){
      if(!prior?.enabled)return {stopped:true,replayed:true};
      await c.query(`UPDATE ${schedules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
      await audit.record(c,ctx,{action:'Compliance report schedule stopped',before:{frequency:prior.frequency}});
      return {stopped:true};
    }
    const frequency=String(input.frequency||'').toUpperCase();
    if(!['WEEKLY','MONTHLY'].includes(frequency))throw new ValidationError('Choose weekly or monthly.');
    if(prior?.enabled&&prior.frequency===frequency)return {saved:true,replayed:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'compliance-schedule:'+((prior?.revision||0)+1),1024,{finished:true});
    await c.query(`INSERT INTO ${schedules} AS s(workspace_id,frequency,authorized_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET frequency=excluded.frequency,enabled=true,authorized_by=excluded.authorized_by,revision=s.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,frequency,ctx.actorId]);
    await audit.record(c,ctx,{action:'Compliance report schedule saved',before:prior?{frequency:prior.frequency,enabled:prior.enabled}:{},after:{frequency}});
    return {saved:true};
  });
}

// The last full week (Monday to Sunday) or month before today.
function lastPeriod(frequency,today){
  if(frequency==='MONTHLY'){const first=today.slice(0,8)+'01',end=addDays(first,-1);return {start:end.slice(0,8)+'01',end};}
  const weekday=(new Date(today+'T00:00:00Z').getUTCDay()+6)%7,monday=addDays(today,-weekday);
  return {start:addDays(monday,-7),end:addDays(monday,-1)};
}

// Worker: produces the scheduled report for the last full period, once.
async function run(job,database){
  const workspaceId=job.workspaceId;
  return tx(database,async c=>{
    const account=await policy.accountState(c,workspaceId);
    if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skipped:true};
    const rule=(await c.query(`SELECT s.* FROM ${schedules} s JOIN users u ON u.id=s.authorized_by JOIN workspaces w ON w.id=s.workspace_id
      AND w.owner_account_id=u.account_id WHERE s.workspace_id=$1 AND s.enabled AND u.role='owner' AND w.deletion_requested_at IS NULL FOR SHARE OF s`,[workspaceId])).rows[0];
    if(!rule)return {skipped:true};
    const ctx={workspaceId,actorId:rule.authorized_by};
    // The period is the one before the business day the routine was queued on.
    const today=await time.today(c,workspaceId),asked=job.payload?.day;
    const day=isDay(asked)&&asked<=today?asked:today;
    const span=lastPeriod(rule.frequency,day),key='schedule:'+rule.frequency+':'+span.start;
    const prior=(await c.query(`SELECT id,status FROM ${reports} WHERE workspace_id=$1 AND request_key=$2`,[workspaceId,key])).rows[0];
    if(prior)return {...prior,replayed:true};
    const content=await build(c,workspaceId,span);
    const alone=policy.permits(account.plan,JOB,'automatic');
    await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
    let blocked=alone?await policy.stopped(c,workspaceId,account,ACTION,true):null;
    if(alone&&!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)blocked='Handle routine work is off for this inventory.';
    const reason=content.gaps.length?'Some facts are missing. Check them before you finalize.':!alone?'A person finalizes each report on this plan.':blocked;
    return save(c,ctx,{key,span,content,status:reason?'DRAFT':'FINAL',reason,wouldFinalize:alone&&!content.gaps.length&&Boolean(blocked),
      automatic:!reason,scheduled:true});
  });
}
async function schedule(c,workspaceId,cycleId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  if(!(await c.query(`SELECT 1 FROM ${schedules} WHERE workspace_id=$1 AND enabled`,[workspaceId])).rowCount)return {queued:false};
  const today=await time.today(c,workspaceId);
  return {queued:(await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'compliance-reports:day:'+today,payload:{cycleId,day:today},priority:70,maxAttempts:3})).created};
}

// Files through the existing export code: one sheet per section, or one PDF.
function title(r){return 'Compliance report '+r.period_start+' to '+r.period_end+(r.status==='FINAL'?'':' (draft, not finalized)');}
function workbook(r){
  const XLSX=require('xlsx'),book=XLSX.utils.book_new(),content=r.content;
  const summary=[['Report',title(r)],['Status',r.status==='FINAL'?'Final':'Draft'],['Prepared',r.automatic?'By StockChief on its own':r.prepared_name||'On the schedule'],
    ['Finalized by',r.finalized_name||(r.status==='FINAL'?'StockChief, on the owner’s schedule':'Not finalized')],['Time zone',content.timeZone],
    ...content.gaps.map(g=>['Missing facts',g]),...content.sections.map(s=>[s.label,s.rows.length+' records'+(s.note?'. '+s.note:'')])];
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(summary),'Summary');
  for(const s of content.sections){
    if(s.rows.length+1>=1048576)throw new ValidationError('This report exceeds the Excel row limit. Choose a shorter period.');
    const sheet=XLSX.utils.aoa_to_sheet([COLUMNS,...s.rows.map(row=>COLUMNS.map(c=>row[c]))]);
    sheet['!cols']=COLUMNS.map(c=>({wch:c==='Detail'?60:16}));
    XLSX.utils.book_append_sheet(book,sheet,s.label.slice(0,31));
  }
  return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
}
function pdf(r){
  const rows=r.content.sections.flatMap(s=>s.rows.length?s.rows.map(row=>({Section:s.label,...row})):[{Section:s.label,When:'',Item:'',Lot:'',Location:'',Quantity:'',Person:'',
    Detail:s.note||'Nothing recorded in this period.',Reference:''}]);
  return require('./exports').pdf({config:{title:title(r)},columns:['Section',...COLUMNS],rows,asOf:r.created_at,
    sourceLabel:'StockChief records | '+(r.status==='FINAL'?'Finalized '+new Date(r.finalized_at).toISOString().slice(0,16).replace('T',' ')+' UTC':'Draft')+(r.content.gaps.length?' | '+r.content.gaps.join(' '):'')});
}
// Saved reports stay downloadable by the owner after a plan change.
async function download(db,ctx,id,format){
  await owner(db,ctx);
  if(!['xlsx','pdf'].includes(format))throw new ValidationError('Choose Excel or PDF.');
  const r=await load(db,ctx,id);
  if(r.status==='DISCARDED')throw new ValidationError('This draft was discarded.');
  return {filename:'compliance-'+r.period_start+'-to-'+r.period_end+(r.status==='FINAL'?'':'-draft')+'.'+format,
    type:format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf',body:format==='xlsx'?workbook(r):await pdf(r)};
}

async function page(db,ctx,{id=null}={}){
  const state=await access(db,ctx);
  const today=await time.today(db,ctx.workspaceId),month=lastPeriod('MONTHLY',today);
  const list=(await db.query(`SELECT id,period_start::text AS period_start,period_end::text AS period_end,status,gaps,automatic,scheduled,reason,would_finalize,created_at
    FROM ${reports} WHERE workspace_id=$1 AND status<>'DISCARDED' ORDER BY created_at DESC,id LIMIT 50`,[ctx.workspaceId])).rows;
  const rule=(await db.query(`SELECT * FROM ${schedules} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0]||null;
  const stop=policy.permits(state.plan,JOB,'automatic')?await policy.stopped(db,ctx.workspaceId,state,ACTION,true):null;
  return {mode:policy.allowance(state.plan,JOB),list,schedule:rule,stop,defaults:month,requestKey:newId('compliance-request'),
    report:id?await load(db,ctx,id):null,columns:COLUMNS};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=(await db.query(`SELECT id,period_start::text AS period_start,period_end::text AS period_end,created_at FROM ${reports}
    WHERE workspace_id=$1 AND status='DRAFT' ORDER BY created_at,id LIMIT 20`,[workspaceId])).rows;
  if(!rows.length)return [];
  return [{kind:'reports',importance:'Needs You',priority:40,grouped:true,
    title:rows.length===1?'A compliance report waits for you':rows.length+' compliance reports wait for you',
    happened:'The report for '+rows[0].period_start+' to '+rows[0].period_end+' is ready to check.',
    why:'A person finalizes reports that are drafts or are missing facts.',recommendation:'Check the report, then finalize it.',
    href:rows.length===1?path+'/'+encodeURIComponent(rows[0].id):path,actionLabel:'Review the report',sourceId:'compliance-reports',at:rows[0].created_at,createdAt:rows[0].created_at}];
}

module.exports={JOB,ACTION,kind,path,SECTIONS,build,prepare,finalize,discard,configure,run,schedule,lastPeriod,download,page,inbox,load};
