
'use strict';

const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const source=require('./supplier-return-evidence');
const {hash,money,cases,sources}=source;
const policy=require('../commercial/agent-plan'),queue=require('../operations/postgres-job-queue');
const audit=require('../operations/postgres-security-audit'),native=require('../operations/postgres-returns');
const storage=require('../commercial/storage-capacity');
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});
const KIND='agent.supplier-return.prepare.v1',href='/autopilot/supplier-returns';
const rules='stockchief_runtime.agent_supplier_return_rules';
function text(value,label,max=240){
  const clean=String(value||'').trim();
  if(!clean||clean.length>max||/[\u0000-\u001f\u007f]/u.test(clean))throw new ValidationError('Record '+label+' on one line.');
  return clean;
}
async function get(db,ctx,id,{lock=false}={}){
  const c=(await db.query('SELECT * FROM '+cases+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),
    [ctx.workspaceId,id])).rows[0];
  if(!c)throw new NotFoundError('That tracked supplier return is unavailable.');
  if(hash(c.evidence)!==c.evidence_hash)throw new ValidationError('The original faulty-goods evidence changed.');
  return c;
}
async function live(db,ctx,c){
  const b=await source.bill(db,ctx,c.bill_id,{lock:true}),e=c.evidence;
  if(b.supplier_id!==c.supplier_id||b.currency!==e.currency||b.purchase_order_id!==e.purchaseOrderId){
    throw new ValidationError('The original receipt, supplier or bill changed.');
  }
  const lines=await source.confirmLines(db,ctx,b,{lines:e.lines},{caseId:c.id});
  if(hash(lines)!==hash(e.lines))throw new ValidationError('Review the latest physical receipt, goods or inspection evidence before continuing.');
  return b;
}
async function example(db,ctx,id,{supplierId,locationId,currency}){
  const c=await get(db,ctx,id);
  if(c.authorization_kind!=='INDIVIDUAL'||c.prepared_by!==ctx.actorId||c.supplier_id!==supplierId||
    c.evidence.currency!==currency||!c.evidence.lines.some(l=>l.locationId===locationId)||!source.dispatchProof(c)){
    throw new ValidationError('Complete an individually approved receipt, handoff and sourced supplier credit in this supplier and location first.');
  }
  const follow=await credited(db,ctx,c);
  if(follow.problem||follow.remaining!==0||follow.status!=='RECONCILED')throw new ValidationError('The teaching example needs its full, verified posted supplier credit.');
  return c;
}
async function routine(db,ctx,c,{lock=false}={}){
  const locations=[...new Set(c.evidence.lines.map(l=>l.locationId))].sort();
  const selected=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=ANY($3::text[])
    AND currency=$4 AND enabled ORDER BY location_id`+(lock?' FOR SHARE':''),[ctx.workspaceId,c.supplier_id,locations,c.evidence.currency])).rows;
  if(selected.length!==locations.length||selected.some(r=>r.authorized_by!==ctx.actorId||Number(r.maximum_minor)<c.evidence.expected)){
    throw new ValidationError('The current owner’s supplier, locations and credit limit do not cover this return.');
  }
  const state=await source.access(db,ctx,{automatic:true,trained:selected.every(r=>r.example_id),stop:true,lock});
  if(policy.allowance(state.plan,115)==='trained'){
    for(const r of selected)await example(db,ctx,r.example_id,{supplierId:r.supplier_id,locationId:r.location_id,currency:r.currency});
  }
  return {kind:state.plan==='pro'?'TRAINED':'CUSTOM',scope:selected.map(r=>[r.id,r.revision])};
}
async function scheduleOne(db,ctx,c){
  try{
    const auth=await routine(db,ctx,c);
    const slot=Math.floor(Date.now()/900000);
    return (await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:KIND,priority:55,maxAttempts:8,
      idempotencyKey:'supplier-return:'+c.id+':'+hash(auth.scope)+':'+slot,payload:{caseId:c.id,scope:auth.scope,actorId:ctx.actorId}})).created;
  }catch(error){if(!source.expected(error))throw error;return false;}
}
async function capture(database,ctx,input){
  return tx(database,async db=>{
    await source.access(db,ctx,{lock:true});
    if(input.physicallyChecked!=='yes'||input.supplierApproved!=='yes')throw new ValidationError('Confirm the physically checked faulty goods and the supplier’s actual authorization.');
    const b=await source.bill(db,ctx,input.billId,{lock:true});
    const requestKey=text(input.requestKey,'the current form key'),reference=text(input.supplierReference,'the supplier’s authorization reference'),
      reason=text(input.reason,'what was physically found faulty',1000);
    const expected=money.userToMinor(input.expected,b.currency,{label:'Expected supplier credit'});
    if(expected<=0||expected>Number(b.total_minor))throw new ValidationError('Use the confirmed positive credit expected from this original bill.');
    const prior=(await db.query('SELECT * FROM '+cases+' WHERE workspace_id=$1 AND request_key=$2',
      [ctx.workspaceId,requestKey])).rows[0];
    if(prior){
      if(prior.evidence.inputHash!==hash(input))throw new ValidationError('This return form already recorded different evidence.');
      return {id:prior.id,replayed:true};
    }
    const lines=await source.confirmLines(db,ctx,b,input);
    const evidence={inputHash:hash(input),supplierId:b.supplier_id,supplier:b.supplier_name,billId:b.id,bill:b.bill_number,
      invoice:b.supplier_invoice_number,purchaseOrderId:b.purchase_order_id,purchaseOrder:b.po_number,currency:b.currency,expected,reference,reason,lines};
    const id=newId('supplier-return-case');
    await storage.reserve(db,ctx.workspaceId,'supplier-return-case:'+id,Buffer.byteLength(JSON.stringify(evidence))*3+16384,{finished:true});
    const c=(await db.query(`INSERT INTO ${cases}(id,workspace_id,supplier_id,bill_id,requested_by,evidence,evidence_hash,request_key,supplier_reference)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`,
    [id,ctx.workspaceId,b.supplier_id,b.id,ctx.actorId,JSON.stringify(evidence),hash(evidence),requestKey,reference.toLowerCase()])).rows[0];
    if(!c)throw new ValidationError('This supplier authorization is already recorded. Review its existing return.');
    for(const l of lines){
      if(!l.holdId){
        await require('../operations/postgres-return-holds').assertCanMove(db,ctx,{...l,serialUnitIds:l.serialUnitIds});
        const reserved=(await db.query(`SELECT coalesce(sum(a.quantity),0) amount FROM sales_order_allocations a
          JOIN sales_order_lines line ON line.workspace_id=a.workspace_id AND line.id=a.sales_order_line_id
          WHERE a.workspace_id=$1 AND a.location_id=$2 AND line.sku_id=$3`,[ctx.workspaceId,l.locationId,l.skuId])).rows[0].amount;
        const held=await db.query(`UPDATE balances SET quality_held=quality_held+$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3
          AND on_hand-quality_held-$5::numeric >= $4`,[ctx.workspaceId,l.skuId,l.locationId,l.quantity,reserved]);
        if(!held.rowCount)throw new ValidationError('The faulty goods are committed or no longer available to hold at this location.');
      }
      await db.query(`INSERT INTO ${sources}(case_id,workspace_id,receipt_line_id,quantity,secondary_quantity,serial_ids,extra_hold)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,ctx.workspaceId,l.receiptLineId,l.quantity,l.secondaryQuantity,l.serialUnitIds,!l.holdId]);
    }
    await audit.record(db,ctx,{action:'Confirmed faulty supplier receipt and return authorization',reference:id,after:{billId:b.id,reference,proof:c.evidence_hash}});
    return {id,queued:await scheduleOne(scoped(db),ctx,c)};
  });
}

async function prepare(db,ctx,c,authority){
  if(c.cancelled_at)throw new ValidationError('This return was cancelled.');
  await live(db,ctx,c);
  const e=c.evidence;
  const request=await native.requestSupplierReturn(scoped(db),ctx,{receiptCase:true,supplierId:c.supplier_id,supplierBillId:c.bill_id,
    expectedCreditMinor:e.expected,reason:e.reason,lines:e.lines,idempotencyKey:'supplier-return-case:'+c.id});
  await native.authorizeSupplierReturn(scoped(db),ctx,request.supplierReturnId,{idempotencyKey:'supplier-return-authorize:'+c.id});
  await db.query(`UPDATE ${cases} SET return_id=$3,prepared_by=$4,authorization_kind=$5,rule_revision=$6,problem=NULL,checked_at=NULL
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,c.id,request.supplierReturnId,ctx.actorId,authority.kind,
    authority.scope?Math.max(...authority.scope.map(pair=>pair[1])):null]);
  await audit.record(db,ctx,{action:'Prepared authorized physical supplier return',reference:c.id,
    after:{returnId:request.supplierReturnId,scope:authority.scope||null,kind:authority.kind}});
  return {id:c.id,returnId:request.supplierReturnId};
}
async function approve(database,ctx,id,input){
  return tx(database,async db=>{
    await source.access(db,ctx,{lock:true,stop:true});
    const c=await get(db,ctx,id,{lock:true});
    if(input.confirmed!=='yes'||input.expectedHash!==c.evidence_hash)throw new ValidationError('Review and approve this exact receipt and supplier authorization.');
    if(c.return_id)return {id,returnId:c.return_id,replayed:true};
    return prepare(db,ctx,c,{kind:'INDIVIDUAL'});
  });
}
async function run(database,workspaceId,p){
  return tx(database,async db=>{
    const ctx={workspaceId,actorId:p.actorId},c=await get(db,ctx,p.caseId,{lock:true});
    if(c.return_id&&!p.track)return {id:c.id,returnId:c.return_id,replayed:true};
    await db.query('SAVEPOINT supplier_return_case');
    try{
      const auth=await routine(db,ctx,c,{lock:true});
      if(hash(auth.scope)!==hash(p.scope))throw new ValidationError('The owner’s supplier return scope changed after this case was queued.');
      if(p.track){
        if(!source.dispatchProof(c))throw new ValidationError('The physical handoff still needs confirmation.');
        const position=await credited(db,ctx,c),originals=await creditSources(db,ctx,c);
        const notes=[];
        for(const note of originals){
          try{
            const result=await require('./agent-supplier-credit-notes').evaluate(db,ctx,note,{authority:'managed-supplier-return:'+c.return_id});
            notes.push({id:note.id,number:result.number,status:result.status,problem:result.problem,amount:result.total,
              proposed:result.candidate?.returnId===c.return_id?result.candidate.amount:null});
          }catch(error){if(!source.expected(error))throw error;notes.push({id:note.id,number:note.invoice_number,problem:error.message});}
        }
        const tracking={amount:position.amount,remaining:position.remaining,problem:position.problem,notes};
        await storage.reserve(db,ctx.workspaceId,'supplier-return-tracking:'+c.id+':'+Math.floor(Date.now()/900000),
          Buffer.byteLength(JSON.stringify(tracking))+4096,{finished:true});
        await db.query('UPDATE '+cases+' SET tracking=$3::jsonb,checked_at=now(),problem=NULL WHERE workspace_id=$1 AND id=$2',
          [workspaceId,c.id,JSON.stringify(tracking)]);
        return {id:c.id,state:position.status,...tracking};
      }
      const result=await prepare(db,ctx,c,auth);
      await db.query('RELEASE SAVEPOINT supplier_return_case');
      return {...result,state:'AUTHORIZED'};
    }catch(error){
      if(!source.expected(error))throw error;
      await db.query('ROLLBACK TO SAVEPOINT supplier_return_case');
      await db.query('UPDATE '+cases+' SET problem=$3,checked_at=now() WHERE workspace_id=$1 AND id=$2',[workspaceId,c.id,error.message]);
      return {id:c.id,state:'HELD'};
    }
  });
}
async function schedule(db,workspaceId){
  const owner=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND EXISTS(SELECT 1 FROM ${rules} r WHERE r.workspace_id=w.id AND r.enabled AND r.authorized_by=u.id)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!owner)return {queued:0};
  const pending=(await db.query(`SELECT c.* FROM ${cases} c WHERE c.workspace_id=$1 AND c.cancelled_at IS NULL
    AND (c.return_id IS NULL OR c.dispatch IS NOT NULL AND (c.checked_at IS NULL OR c.checked_at<=now()-interval '15 minutes')
      AND EXISTS(SELECT 1 FROM supplier_returns r WHERE r.workspace_id=c.workspace_id AND r.id=c.return_id AND r.status='AWAITING_CREDIT'))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.evidence->'lines') line WHERE NOT EXISTS(
      SELECT 1 FROM ${rules} r WHERE r.workspace_id=c.workspace_id AND r.supplier_id=c.supplier_id AND r.enabled AND r.authorized_by=$2
      AND r.location_id=line->>'locationId' AND r.currency=c.evidence->>'currency' AND r.maximum_minor>=(c.evidence->>'expected')::bigint))
    ORDER BY c.checked_at NULLS FIRST,c.created_at,c.id LIMIT 50`,[workspaceId,owner.id])).rows;
  let queued=0;
  const ctx={workspaceId,actorId:owner.id};
  for(const c of pending){
    if(!c.return_id){if(await scheduleOne(db,ctx,c))queued++;continue;}
    try{
      const auth=await routine(db,ctx,c);
      const slot=Math.floor(Date.now()/900000);
      const job=await queue.enqueue(db,{workspaceId,kind:KIND,priority:60,maxAttempts:8,
        idempotencyKey:'supplier-return-track:'+c.id+':'+hash(auth.scope)+':'+slot,
        payload:{caseId:c.id,scope:auth.scope,actorId:ctx.actorId,track:true}});
      if(job.created)queued++;
    }catch(error){if(!source.expected(error))throw error;}
  }
  return {queued};
}

async function releaseCaseStock(db,ctx,c){
  const released=(await db.query(`UPDATE ${sources} SET hold_active=false WHERE workspace_id=$1 AND case_id=$2 AND hold_active
    RETURNING receipt_line_id,quantity,extra_hold`,[ctx.workspaceId,c.id])).rows;
  if(released.length!==c.evidence.lines.length)throw new ValidationError('The physical return hold no longer matches the confirmed goods.');
  for(const l of c.evidence.lines){
    const row=released.find(r=>r.receipt_line_id===l.receiptLineId);
    if(row.extra_hold){
      const changed=await db.query('UPDATE balances SET quality_held=quality_held-$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND quality_held>=$4',
        [ctx.workspaceId,l.skuId,l.locationId,row.quantity]);
      if(!changed.rowCount)throw new ValidationError('Review the exact faulty-goods hold before continuing.');
    }
  }
}
async function cancel(database,ctx,id,input){
  return tx(database,async db=>{
    await source.access(db,ctx,{lock:true,stop:true});
    const c=await get(db,ctx,id,{lock:true});
    if(c.cancelled_at)return {id,replayed:true};
    if(c.dispatch||input.confirmed!=='yes'||input.expectedHash!==c.evidence_hash)throw new ValidationError('Only an exact return that has not left can be cancelled.');
    if(c.return_id){
      const changed=await db.query("UPDATE supplier_returns SET status='CANCELLED' WHERE workspace_id=$1 AND id=$2 AND status='AUTHORIZED'",
        [ctx.workspaceId,c.return_id]);
      if(!changed.rowCount)throw new ValidationError('The native supplier return is no longer awaiting dispatch.');
    }
    await releaseCaseStock(db,ctx,c);
    await db.query('UPDATE '+cases+' SET cancelled_at=now(),problem=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
    await audit.record(db,ctx,{action:'Cancelled an unshipped supplier return',reference:id});
    return {id};
  });
}

async function dispatch(database,ctx,id,input){
  return tx(database,async db=>{
    await source.access(db,ctx,{lock:true,stop:true});
    const c=await get(db,ctx,id,{lock:true});
    const date=text(input.shippedOn,'the actual date the goods left'),reference=text(input.dispatchReference,'the actual handoff reference');
    const businessTime=require('../lib/business-time');
    const {timeZone}=await businessTime.forWorkspace(db,ctx.workspaceId);
    const today=businessTime.context(timeZone).calendarDate;
    if(input.confirmed!=='yes'||input.expectedHash!==c.evidence_hash||!c.return_id||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||
      c.cancelled_at||date>today||c.evidence.lines.some(l=>date<businessTime.context(timeZone,new Date(l.receivedAt)).calendarDate)){
      throw new ValidationError('Confirm the exact goods and actual handoff date and reference before recording this dispatch.');
    }
    if(c.dispatch){
      if(!source.dispatchProof(c)||c.dispatch.shippedOn!==date||c.dispatch.reference!==reference)throw new ValidationError('This return already records a different handoff.');
      return {id,returnId:c.return_id,replayed:true};
    }
    await live(db,ctx,c);
    await releaseCaseStock(db,ctx,c);
    for(const l of c.evidence.lines){
      if(!l.holdId)continue;
      const changed=await db.query(`UPDATE stockchief_runtime.agent_quality_holds SET returned_quantity=returned_quantity+$3,revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND status='FAILED' AND inspection=$4::jsonb
          AND returned_quantity+$3<=(inspection->>'damagedQuantity')::integer+coalesce((inspection->>'returnedBeforeInspection')::int,0)`,[ctx.workspaceId,l.holdId,l.quantity,JSON.stringify(l.inspection)]);
      if(!changed.rowCount)throw new ValidationError('The exact failed quality hold changed before dispatch.');
    }
    const result=await native.shipSupplierReturn(scoped(db),ctx,c.return_id,{
      shippedAt:date,dispatchCaseId:id,idempotencyKey:'supplier-return-dispatch:'+c.id});
    const proof={shippedOn:date,reference,confirmedBy:ctx.actorId,returnId:c.return_id,lines:result.lines};
    await db.query('UPDATE '+cases+' SET dispatch=$3::jsonb,dispatch_hash=$4 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,id,JSON.stringify(proof),hash(proof)]);
    await audit.record(db,ctx,{action:'Confirmed physical supplier handoff',reference:id,after:proof});
    return {id,returnId:c.return_id};
  });
}

async function liveHandoff(db,ctx,c){
  if(!source.dispatchProof(c))return false;
  const rows=(await db.query(`SELECT m.id,m.quantity_delta,c.cost_delta_minor,c.journal_entry_id,j.status,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') reversed
    FROM movements m JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
    WHERE m.workspace_id=$1 AND m.id=ANY($2::text[]) AND c.cost_source_type='supplier_return_shipment' AND c.cost_source_record_id=$3`,
    [ctx.workspaceId,c.dispatch.lines.map(l=>l.movementId),c.return_id])).rows;
  return rows.length===c.dispatch.lines.length&&c.dispatch.lines.every(l=>rows.some(r=>r.id===l.movementId
    &&Number(r.quantity_delta)===-l.quantity&&Number(r.cost_delta_minor)===-l.costMinor
    &&r.journal_entry_id===l.journalEntryId&&!r.reversed&&(!l.journalEntryId||r.status==='POSTED')));
}
async function credited(db,ctx,c){
  const r=(await db.query('SELECT status,return_number,actual_credit_minor FROM supplier_returns WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,c.return_id])).rows[0];
  const rows=(await db.query(`SELECT a.credit_id,a.source_number,a.intake_id,a.source_hash,a.return_cost_minor,b.currency,b.bill_number,
    p.amount_minor,p.journal_entry_id,j.status journal_status,
    EXISTS(SELECT 1 FROM accounting_journal_entries v WHERE v.workspace_id=j.workspace_id AND v.reversal_of_entry_id=j.id AND v.status='POSTED') reversed,
    coalesce((SELECT sum(l.debit_minor-l.credit_minor) FROM accounting_journal_lines l
      JOIN accounting_accounts ac ON ac.workspace_id=l.workspace_id AND ac.id=l.account_id AND ac.system_key='ACCOUNTS_PAYABLE'
      WHERE l.workspace_id=j.workspace_id AND l.entry_id=j.id AND l.supplier_id=$3 AND l.currency=b.currency),0) payable,
    coalesce((SELECT sum(l.credit_minor-l.debit_minor) FROM accounting_journal_lines l
      JOIN accounting_accounts ac ON ac.workspace_id=l.workspace_id AND ac.id=l.account_id AND ac.system_key='SUPPLIER_CREDITS_RECEIVABLE'
      WHERE l.workspace_id=j.workspace_id AND l.entry_id=j.id AND l.supplier_id=$3 AND l.currency=b.currency),0) cleared
    FROM stockchief_runtime.agent_supplier_credit_applications a
    JOIN accounting_supplier_credits p ON p.workspace_id=a.workspace_id AND p.id=a.credit_id AND p.supplier_id=$3
    JOIN accounting_supplier_bills b ON b.workspace_id=p.workspace_id AND b.id=p.supplier_bill_id
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id
    WHERE a.workspace_id=$1 AND a.supplier_return_id=$2 ORDER BY a.approved_at,a.credit_id`,[ctx.workspaceId,c.return_id,c.supplier_id])).rows;
  const valid=rows.filter(p=>!p.reversed&&p.journal_status==='POSTED'&&p.currency===c.evidence.currency&&
    Number(p.payable)===Number(p.amount_minor)&&Number(p.cleared)===Number(p.return_cost_minor));
  const amount=money.sum(valid.map(x=>Number(x.amount_minor))),cost=money.sum(valid.map(x=>Number(x.return_cost_minor)));
  const movementProof=c.dispatch?await liveHandoff(db,ctx,c):true;
  const problem=!movementProof||rows.length!==valid.length||amount!==Number(r?.actual_credit_minor||0)||amount>c.evidence.expected
    ?'The posted credit or payable evidence changed. Review the original accounting before applying another note.':null;
  return {status:r?.status||'REQUESTED',returnNumber:r?.return_number,rows,amount,cost,remaining:Math.max(0,c.evidence.expected-amount),problem};
}

async function configure(database,ctx,id,input){
  return tx(database,async db=>{
    const c=await get(db,ctx,id);
    await source.owner(db,ctx,{lock:true});
    const loc=text(input.locationId,'the exact receiving location'),e=c.evidence;
    if(!e.lines.some(l=>l.locationId===loc))throw new ValidationError('Choose a receiving location on this exact return.');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['supplier-return-rule:'+ctx.workspaceId]);
    const prior=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND currency=$4 FOR UPDATE`,
      [ctx.workspaceId,c.supplier_id,loc,e.currency])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the current supplier return authority before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled)await db.query('UPDATE '+rules+' SET enabled=false,revision=revision+1 WHERE id=$1',[prior.id]);
      return {stopped:true};
    }
    const state=await source.access(db,ctx);
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact supplier, location, currency and expected credit limit.');
    const amount=money.userToMinor(input.maximum,e.currency,{label:'Maximum expected credit'});
    if(amount<=0||amount<e.expected)throw new ValidationError('Set a positive credit limit that covers this reviewed return.');
    const trained=policy.allowance(state.plan,115)==='trained';
    if(trained)await example(db,ctx,c.id,{supplierId:c.supplier_id,locationId:loc,currency:e.currency});
    await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?.enabled?0:1);
    const ruleId=prior?.id||newId('supplier-return-rule');
    await storage.reserve(db,ctx.workspaceId,'supplier-return-rule:'+ruleId+':'+((prior?.revision||0)+1),4096,{finished:true});
    await db.query(`INSERT INTO ${rules}(id,workspace_id,supplier_id,location_id,currency,authorized_by,maximum_minor,example_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id,location_id,currency) DO UPDATE
      SET authorized_by=EXCLUDED.authorized_by,maximum_minor=EXCLUDED.maximum_minor,example_id=EXCLUDED.example_id,enabled=true,
      revision=agent_supplier_return_rules.revision+1`,[ruleId,ctx.workspaceId,c.supplier_id,loc,e.currency,ctx.actorId,amount,trained?c.id:null]);
    await audit.record(db,ctx,{action:'Authorized routine supplier return preparation',reference:ruleId,
      after:{supplierId:c.supplier_id,locationId:loc,currency:e.currency,amount,example:trained?c.id:null}});
    return {id:ruleId};
  });
}
async function creditSources(db,ctx,c,{offset=0}={}){
  const position=await credited(db,ctx,c);
  return (await db.query(`SELECT q.* FROM stockchief_runtime.agent_supplier_invoice_intakes q
    WHERE q.workspace_id=$1 AND q.supplier_id=$2 AND q.status='CREDIT_REVIEW' AND (
      lower(btrim(q.document->>'supplierReturnReference'))=ANY($3::text[])
      OR (nullif(q.document->>'supplierReturnReference','') IS NULL AND lower(btrim(q.document->>'originalInvoiceNumber'))=ANY($4::text[])))
    ORDER BY q.created_at DESC,q.id LIMIT 51 OFFSET $5`,[ctx.workspaceId,c.supplier_id,
    [c.supplier_reference,String(position.returnNumber||'').toLowerCase()],[c.evidence.invoice,c.evidence.bill].filter(Boolean).map(v=>v.trim().toLowerCase()),offset])).rows;
}
async function page(db,ctx,{id,billId,holdId,number=1}={}){
  const state=await source.access(db,ctx);
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  if(id){
    const c=await get(db,ctx,id),position=await credited(db,ctx,c);
    const notes=c.dispatch?await creditSources(db,ctx,c,{offset:(number-1)*50}):[];
    const scopedRules=(await db.query('SELECT * FROM '+rules+' WHERE workspace_id=$1 AND supplier_id=$2 AND currency=$3 ORDER BY location_id',
      [ctx.workspaceId,c.supplier_id,c.evidence.currency])).rows;
    return {c,position,notes:notes.slice(0,50),today,number,more:notes.length>50,scopedRules,
      pro:policy.allowance(state.plan,115)==='trained',canTeach:c.authorization_kind==='INDIVIDUAL'&&c.prepared_by===ctx.actorId&&
        source.dispatchProof(c)&&position.status==='RECONCILED'&&!position.problem&&position.remaining===0};
  }
  let bill=null,lines=[],hold=null;
  if(holdId){
    hold=(await db.query(`SELECT h.id,h.receipt_line_id,rl.purchase_order_line_id,r.purchase_order_id FROM stockchief_runtime.agent_quality_holds h
      JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
      JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
      WHERE h.workspace_id=$1 AND h.id=$2 AND h.status='FAILED' AND (h.inspection->>'damagedQuantity')::int+coalesce((h.inspection->>'returnedBeforeInspection')::int,0)>h.returned_quantity`,[ctx.workspaceId,holdId])).rows[0];
    if(!hold)throw new ValidationError('Choose a failed receipt inspection with verified damaged units still to return.');
  }
  if(billId){
    bill=await source.bill(db,ctx,billId);
    if(hold&&hold.purchase_order_id!==bill.purchase_order_id)throw new ValidationError('This bill does not match the failed inspection’s purchase order.');
    lines=await source.receipts(db,ctx,bill.purchase_order_id,hold?[hold.receipt_line_id]:null);
  }
  const recent=(await db.query(`SELECT id,return_id,evidence,problem,dispatch,created_at,cancelled_at FROM ${cases} WHERE workspace_id=$1
    ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const bills=bill?[]:(await db.query(`SELECT b.id,b.bill_number,b.supplier_invoice_number,p.po_number,s.name supplier_name
    FROM accounting_supplier_bills b JOIN purchase_orders p ON p.workspace_id=b.workspace_id AND p.id=b.purchase_order_id
    JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id
    WHERE b.workspace_id=$1 AND b.status IN('OPEN','PARTIALLY_PAID','PAID') AND ($3::text IS NULL OR b.purchase_order_id=$3)
    AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM accounting_supplier_bill_lines l WHERE l.workspace_id=b.workspace_id
      AND l.bill_id=b.id AND l.purchase_order_line_id=$4))
    ORDER BY b.created_at DESC,b.id LIMIT 51 OFFSET $2`,
    [ctx.workspaceId,(number-1)*50,hold?.purchase_order_id||null,hold?.purchase_order_line_id||null])).rows;
  return {c:null,bill,lines,bills:bills.slice(0,50),holdId,today,number,more:recent.length>50||bills.length>50,recent:recent.slice(0,50)};
}
const definition={id:115,key:'supplier-return-follow-through',label:'Return faulty goods and track the supplier credit',
  readPage:async()=>({summary:'Review exact receipt, supplier authorization, physical handoff and each posted credit.',rows:[{Action:'Open tracked supplier returns',link:href}],more:false})};
module.exports={KIND,href,get,capture,approve,run,schedule,dispatch,cancel,credited,configure,page,definition};
