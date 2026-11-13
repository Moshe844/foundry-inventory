'use strict';

// Job 49: updates item cost with landed cost: freight, duty and fees.
//
// When a supplier or carrier bill is posted for a recorded delivery (the bill
// names the delivery), each of its expense lines that is freight, duty,
// insurance or handling is split over the goods on that delivery and posted
// through the existing landed-cost allocation: one exact journal moves the
// expense into stock value. Quantities, supplier balances and payments stay
// the same.
//
// Pro drafts each allocation for approval until the owner has approved one of
// the same kind (same supplier or carrier and cost type) and saved a limit for
// it. Custom needs only the saved limit, no example. Either way StockChief posts
// on its own only in routine mode, outside shadow, pause, watch mode, Watch only
// and Ask me first, and never over the limit. These always wait for a person:
// a bill not matched to one delivery, a cost type it cannot read, a bill in
// another currency (there is no recorded exchange rate), and goods already sold
// or moved since they arrived, whose cost of goods sold would change too. Every
// post is audited, replays safely and is undone by a reversing entry.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const costs=require('./postgres-landed-costs');

const JOB=49,ACTION='landed_cost.apply',kind='agent.landed-cost-bill.v1',path='/autopilot/landed-cost-bills';
const bills='stockchief_runtime.agent_landed_cost_bills',rules='stockchief_runtime.agent_landed_cost_rules';
const TYPES=['freight','duty','insurance','handling'],METHODS=['quantity','value','weight'];
const OPEN=['WATCHING','REVIEW','HELD'],FINAL=['POSTED','KEPT','UNDONE','HANDLED'];
const methodLabels={quantity:'units received',value:'original cost',weight:'recorded weight'};
// The split StockChief drafts before the owner chooses one: duty and insurance
// are charged on the goods' value, freight and handling by units received.
const defaults={freight:'quantity',handling:'quantity',duty:'value',insurance:'value'};
// The bill's own words, read only on a bill for a delivery. Exactly one kind must match.
const words={freight:/\b(freight|shipping|carriage|haulage|trucking|drayage|courier|cartage)\b/i,
  duty:/\b(duty|duties|customs|tariffs?)\b/i,insurance:/\b(insurance|insured)\b/i,
  handling:/\b(handling|brokerage|clearance|wharfage|demurrage|terminal)\b/i};
const DISCOVERY_DAYS=120;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409].includes(error.status);
const included=account=>policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'draft');
const since=()=>new Date(Date.now()-DISCOVERY_DAYS*86400000).toISOString();

function costType(line,linked){
  if(line.landed_cost_kind)return line.landed_cost_kind;
  if(!linked)return null;
  const found=TYPES.filter(type=>words[type].test(String(line.description||'')));
  return found.length===1?found[0]:null;
}

// Plain words for the existing allocation's refusals.
function plain(message){
  if(/sold, moved or reduced/.test(message))
    return 'Some of these goods were sold or moved since they arrived, so their cost of goods sold would change too. A person handles this one: keep it as an expense, or adjust it with your accountant.';
  return message;
}

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can change stock cost from delivery bills.');
}

// A person's own step. Approving follows the same pause, shadow and watch rules
// as every other agent approval; keeping a bill as an expense or undoing stays open.
async function access(db,ctx,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
  return state;
}

// What the routine may do right now for the whole inventory. "watch" means it
// only records what it would do; "blocked" means it drafts but does not post.
async function gates(c,workspaceId,{lock=true}={}){
  const account=await policy.accountState(c,workspaceId);
  if(!included(account))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  if(lock)await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const watch=await policy.stopped(c,workspaceId,account,ACTION,false);
  let blocked=watch||await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)
    blocked='Handle routine work is off for this inventory.';
  const book=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0]?.base_currency||null;
  return {draft:true,account,workspaceId,owner:person.id,watch,blocked,book};
}

// The owner's limit for one supplier or carrier and cost type, and whether the
// person who saved it is still the owner.
async function ruleFor(db,workspaceId,supplierId,category,{lock=false}={}){
  if(!supplierId||!category)return null;
  return (await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner'
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)) AS current
    FROM ${rules} r WHERE r.workspace_id=$1 AND r.supplier_id=$2 AND r.category=$3 ${lock?'FOR SHARE OF r':''}`,
  [workspaceId,supplierId,category])).rows[0]||null;
}

// An allocation of the same kind that the owner approved themselves: this
// supplier or carrier, this cost type and currency. One posted on its own never counts.
async function example(db,workspaceId,{supplierId,category,currency,personId,documentId=null}){
  if(!personId||!supplierId||!category)return null;
  return (await db.query(`SELECT d.id,d.allocation_method FROM landed_cost_documents d
    WHERE d.workspace_id=$1 AND d.status IN ('APPLIED','REVERSED') AND d.applied_automatically IS FALSE
      AND d.approved_by_user_id=$5 AND d.currency=$4 AND ($6::text IS NULL OR d.id=$6)
      AND EXISTS(SELECT 1 FROM landed_cost_charges ch
        JOIN accounting_supplier_bill_lines l ON l.workspace_id=ch.workspace_id AND l.id=ch.source_bill_line_id
        JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
        WHERE ch.workspace_id=d.workspace_id AND ch.document_id=d.id AND b.supplier_id=$2 AND ch.category=$3)
    ORDER BY d.applied_at DESC,d.id LIMIT 1`,[workspaceId,supplierId,category,currency,personId,documentId])).rows[0]||null;
}

// Whether this exact allocation may post without a person, and if not, why.
async function authority(c,gate,base,rule){
  const who=base.supplierName||'this supplier',what=base.category;
  if(base.chosen)return {reason:'You chose the delivery, cost type or split for this bill, so you approve it.'};
  const trained=policy.allowance(gate.account.plan,JOB)==='trained';
  if(!rule)return {reason:trained?'Approve one '+what+' bill from '+who+' yourself, then save a limit, to let StockChief post these on its own.':
    'Save a limit for '+what+' bills from '+who+' to let StockChief post them on its own.'};
  if(!rule.enabled)return {rule,reason:'You asked to approve every '+what+' bill from '+who+'.'};
  if(!rule.current)return {rule,reason:'The limit for these bills was saved by someone who is no longer the owner. Save it again.'};
  const taught=Boolean(rule.example_document_id&&await example(c,gate.workspaceId,{supplierId:base.supplierId,category:what,
    currency:rule.currency,personId:rule.authorized_by,documentId:rule.example_document_id}));
  if(!policy.permits(gate.account.plan,JOB,'automatic',{trained:taught}))
    return {rule,reason:'Approve one '+what+' bill from '+who+' yourself, then save its limit again.'};
  if(rule.currency!==base.currency||base.amount>Number(rule.maximum_minor))
    return {rule,reason:'This is over your '+money.format(Number(rule.maximum_minor),rule.currency)+' limit for '+what+' bills from '+who+'.'};
  return {rule,allowed:true};
}

function baseFor(bill,line,row){
  const chosen=Boolean(row?.chosen_by),receiptId=chosen&&row.receipt_id?row.receipt_id:bill.purchase_receipt_id||null;
  return {workspaceId:bill.workspace_id,billLineId:line.id,billId:bill.id,billNumber:bill.bill_number,supplierId:bill.supplier_id,supplierName:bill.supplier_name,
    receiptId,category:chosen&&row.category?row.category:costType(line,Boolean(receiptId)),currency:bill.currency,
    amount:Number(line.line_total_minor),chosen,method:row?.method||null,attempt:row?.attempt||1,documentId:row?.document_id||null};
}

async function save(c,base,{status,reason=null,wouldPost=false,automatic=false,decidedBy=null,ruleRevision=null}){
  await c.query(`INSERT INTO ${bills} AS r(workspace_id,bill_line_id,bill_id,supplier_id,receipt_id,category,method,currency,amount_minor,status,
      reason,would_post,automatic,document_id,attempt,decided_by,rule_revision,decided_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $10 IN ('POSTED','KEPT','UNDONE','HANDLED') THEN clock_timestamp() END)
    ON CONFLICT(workspace_id,bill_line_id) DO UPDATE SET supplier_id=excluded.supplier_id,receipt_id=excluded.receipt_id,category=excluded.category,
      method=excluded.method,currency=excluded.currency,amount_minor=excluded.amount_minor,status=excluded.status,reason=excluded.reason,
      would_post=excluded.would_post,automatic=excluded.automatic,document_id=excluded.document_id,attempt=excluded.attempt,
      decided_by=excluded.decided_by,rule_revision=excluded.rule_revision,decided_at=excluded.decided_at,checked_at=clock_timestamp()
    WHERE r.status IN ('WATCHING','REVIEW','HELD')`,
  [base.workspaceId,base.billLineId,base.billId,base.supplierId,base.receiptId,base.category,base.method,base.currency,base.amount,status,
    reason,wouldPost,automatic,base.documentId,base.attempt,decidedBy,ruleRevision]);
  return status;
}

// A draft this routine prepared stops reserving the expense once a person has to look.
async function release(c,ctx,base){
  if(!base.documentId)return;
  const doc=(await c.query('SELECT status FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,base.documentId])).rows[0];
  if(doc?.status==='DRAFT')await costs.voidDraft(scoped(c),ctx,base.documentId);
  base.documentId=null;base.attempt+=1;
}

// One bill line, exactly one outcome. Nothing here guesses a delivery, a cost
// type or an exchange rate.
async function decide(c,gate,bill,line,row){
  const ctx={workspaceId:gate.workspaceId,actorId:gate.owner},base=baseFor(bill,line,row);
  if(!row&&!bill.purchase_receipt_id&&!line.landed_cost_kind)return null;
  if(base.documentId){
    // A person finished the draft on the allocation page itself.
    const doc=(await c.query('SELECT status,approved_by_user_id,applied_automatically FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',
      [gate.workspaceId,base.documentId])).rows[0];
    if(doc?.status==='APPLIED')return save(c,base,{status:'POSTED',automatic:doc.applied_automatically===true,decidedBy:doc.approved_by_user_id});
    if(doc?.status==='REVERSED')return save(c,base,{status:'UNDONE',decidedBy:doc.approved_by_user_id});
    if(doc?.status==='VOID')return save(c,{...base,documentId:null,attempt:base.attempt+1},{status:'KEPT',reason:'The draft allocation was discarded.'});
  }
  const other=(await c.query(`SELECT d.document_number FROM landed_cost_charges ch JOIN landed_cost_documents d ON d.workspace_id=ch.workspace_id AND d.id=ch.document_id
    WHERE ch.workspace_id=$1 AND ch.source_bill_line_id=$2 AND d.status NOT IN ('VOID','REVERSED') AND ($3::text IS NULL OR d.id<>$3) LIMIT 1`,
  [gate.workspaceId,line.id,base.documentId])).rows[0];
  if(other){await release(c,ctx,base);return save(c,base,{status:'HANDLED',reason:'Allocated by hand on '+other.document_number+'.'});}
  const held=async reason=>{await release(c,ctx,base);return save(c,base,{status:'HELD',reason});};
  if(!['OPEN','PARTIALLY_PAID','PAID'].includes(bill.status)||!bill.posted)return held('This bill is not posted in your books, so nothing moves into stock cost.');
  if(!base.receiptId)return held('This bill does not say which delivery it is for. Choose the delivery, or keep it as an expense.');
  if(!base.category)return held('StockChief cannot tell if this is freight, duty, insurance or handling. Choose the cost type, or keep it as an expense.');
  if(!gate.book)return held('Set up your accounting currency first.');
  if(bill.currency!==gate.book)return held('This bill is in '+bill.currency+' and your books are in '+gate.book+'. There is no recorded exchange rate for it, so a person allocates it.');
  const receipt=(await c.query('SELECT id,purchase_order_id FROM purchase_order_receipts WHERE workspace_id=$1 AND id=$2',[gate.workspaceId,base.receiptId])).rows[0];
  if(!receipt)return held('That delivery is no longer in this inventory.');
  try{await costs.receiptFacts(c,ctx,[receipt.id],receipt.purchase_order_id);}
  catch(error){if(error.code!=='validation_error')throw error;return held(plain(error.message));}
  const rule=await ruleFor(c,gate.workspaceId,base.supplierId,base.category,{lock:true});
  base.method=base.chosen&&row.method?row.method:rule?.method||defaults[base.category];
  const allowed=await authority(c,gate,base,rule);
  // Shadow, watch mode and Watch only: record what it would do and prepare nothing.
  if(gate.watch)return save(c,base,{status:base.documentId?'REVIEW':'WATCHING',reason:gate.watch,wouldPost:Boolean(allowed.allowed)});
  if(base.documentId){
    const doc=(await c.query('SELECT status,allocation_method FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',[gate.workspaceId,base.documentId])).rows[0];
    if(doc?.status!=='DRAFT'||doc.allocation_method!==base.method)await release(c,ctx,base);
  }
  if(!base.documentId)base.documentId=(await costs.createDraft(scoped(c),ctx,{purchaseOrderId:receipt.purchase_order_id,receiptIds:[receipt.id],
    charges:[{sourceBillLineId:line.id,amountMinor:base.amount,category:base.category}],method:base.method,requestKey:'landed-bill:'+line.id+':'+base.attempt})).id;
  const built=await costs.build(scoped(c),ctx,{id:base.documentId});
  if(!allowed.allowed||gate.blocked)return save(c,base,{status:'REVIEW',reason:allowed.allowed?gate.blocked:allowed.reason,wouldPost:Boolean(allowed.allowed)});
  // Job 205: over the owner's two-person amount it waits for two people.
  const twoPeople=await require('../autopilot/two-person-approval').landedCostWaiting(c,ctx,built.payload);
  if(twoPeople)return save(c,base,{status:'REVIEW',reason:twoPeople,wouldPost:true});
  const posted=await costs.applyInTransaction(c,ctx,built.payload,{routine:{trained:true}});
  await save(c,base,{status:'POSTED',automatic:true,decidedBy:gate.owner,ruleRevision:allowed.rule.revision});
  // Job 201: a delivery cost posted on its own counts toward StockChief's usual day.
  await require('../autopilot/circuit-breaker').note(c,gate.workspaceId,{key:'landed-cost:'+posted.documentNumber,kind:'landed_cost',
    reference:bill.bill_number,amountMinor:base.amount,currency:base.currency});
  await audit.record(c,ctx,{action:'Delivery cost posted to stock on its own',reference:posted.documentNumber,
    after:{bill:bill.bill_number,supplierId:base.supplierId,costType:base.category,amount:money.format(base.amount,base.currency),split:base.method,
      limit:money.format(Number(allowed.rule.maximum_minor),allowed.rule.currency),journalEntryId:posted.journalEntryId,automatic:true}});
  return 'POSTED';
}

const billSql=`SELECT b.*,v.name AS supplier_name,
    coalesce(e.status='POSTED' AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries x WHERE x.workspace_id=e.workspace_id
      AND x.reversal_of_entry_id=e.id AND x.status='POSTED'),false) AS posted
  FROM accounting_supplier_bills b LEFT JOIN suppliers v ON v.workspace_id=b.workspace_id AND v.id=b.supplier_id
  LEFT JOIN accounting_journal_entries e ON e.workspace_id=b.workspace_id AND e.id=b.journal_entry_id
  WHERE b.workspace_id=$1 AND b.id=$2`;
const lineSql=`SELECT l.id,l.bill_id,l.line_number,l.description,l.line_total_minor,l.landed_cost_kind FROM accounting_supplier_bill_lines l
  JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.debit_account_id AND a.account_type='EXPENSE'
  WHERE l.workspace_id=$1 AND l.bill_id=$2`;

// A failure that needs a person never stops the rest of the bill.
async function settle(c,gate,bill,line,row){
  await c.query('SAVEPOINT landed_cost_bill_line');
  try{
    const outcome=await decide(c,gate,bill,line,row);
    await c.query('RELEASE SAVEPOINT landed_cost_bill_line');
    return outcome;
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT landed_cost_bill_line');
    const base=baseFor(bill,line,row);
    if(base.documentId){
      await c.query('SAVEPOINT landed_cost_bill_release');
      try{await release(c,{workspaceId:gate.workspaceId,actorId:gate.owner},base);await c.query('RELEASE SAVEPOINT landed_cost_bill_release');}
      catch(failure){if(!expected(failure))throw failure;await c.query('ROLLBACK TO SAVEPOINT landed_cost_bill_release');}
    }
    return save(c,base,{status:'HELD',reason:plain(error.message)});
  }
}

async function processBill(c,workspaceId,billId,{recheck=false}={}){
  const gate=await gates(c,workspaceId);
  if(!gate.draft)return null;
  const bill=(await c.query(billSql,[workspaceId,billId])).rows[0];
  if(!bill)return {};
  const lines=(await c.query(lineSql+' ORDER BY l.line_number LIMIT 200',[workspaceId,billId])).rows,counts={};
  for(const line of lines){
    const row=(await c.query(`SELECT * FROM ${bills} WHERE workspace_id=$1 AND bill_line_id=$2 FOR UPDATE`,[workspaceId,line.id])).rows[0]||null;
    if(row&&!(row.status==='WATCHING'||row.status==='REVIEW'||(recheck&&row.status==='HELD')))continue;
    const outcome=await settle(c,gate,bill,line,row);
    if(outcome)counts[outcome.toLowerCase()]=(counts[outcome.toLowerCase()]||0)+1;
  }
  return counts;
}

// Recent bills for a delivery, or with a line marked as a delivery cost, that
// have a line StockChief has not looked at yet; and lines still waiting.
const discoverySql=`WITH candidates AS (
    SELECT b.id FROM accounting_supplier_bills b WHERE b.workspace_id=$1 AND b.purchase_receipt_id IS NOT NULL AND b.created_at>=$2
    UNION SELECT k.bill_id FROM accounting_supplier_bill_lines k WHERE k.workspace_id=$1 AND k.landed_cost_kind IS NOT NULL AND k.created_at>=$2)
  SELECT x.id FROM candidates x JOIN accounting_supplier_bills b ON b.workspace_id=$1 AND b.id=x.id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
  WHERE EXISTS(SELECT 1 FROM accounting_supplier_bill_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.debit_account_id
    AND a.account_type='EXPENSE' WHERE l.workspace_id=b.workspace_id AND l.bill_id=b.id
    AND NOT EXISTS(SELECT 1 FROM ${bills} r WHERE r.workspace_id=l.workspace_id AND r.bill_line_id=l.id))`;

async function pending(db,workspaceId,{recheck=false}={}){
  return (await db.query(`SELECT DISTINCT id FROM (${discoverySql}
    UNION SELECT r.bill_id FROM ${bills} r WHERE r.workspace_id=$1 AND (r.status IN ('WATCHING','REVIEW') OR ($3 AND r.status='HELD'))) found LIMIT 50`,
  [workspaceId,since(),recheck])).rows.map(r=>r.id);
}

// Worker: one posted bill, or everything waiting in the inventory.
async function run(job,database){
  const workspaceId=job.workspaceId,recheck=job.payload?.recheck===true;
  const account=await policy.accountState(database,workspaceId);
  if(!included(account))return {skipped:true};
  const ids=job.payload?.billId?[job.payload.billId]:await pending(database,workspaceId,{recheck});
  const totals={posted:0,review:0,held:0,watching:0};
  for(const id of ids){
    const result=await tx(database,c=>processBill(c,workspaceId,id,{recheck}));
    if(!result)return {skipped:true,...totals};
    for(const [key,value] of Object.entries(result))totals[key]=(totals[key]||0)+value;
  }
  return totals;
}

// Called when a supplier bill is posted, inside the same transaction.
async function queue(db,workspaceId,billId){
  const account=await policy.accountState(db,workspaceId);
  if(!included(account))return {queued:false};
  const candidate=(await db.query(`SELECT 1 FROM accounting_supplier_bills b WHERE b.workspace_id=$1 AND b.id=$2
    AND (b.purchase_receipt_id IS NOT NULL OR EXISTS(SELECT 1 FROM accounting_supplier_bill_lines l
      WHERE l.workspace_id=b.workspace_id AND l.bill_id=b.id AND l.landed_cost_kind IS NOT NULL))`,[workspaceId,billId])).rowCount;
  if(!candidate)return {queued:false};
  return {queued:(await jobs.enqueue(scoped(db),{workspaceId,kind,idempotencyKey:'landed-cost-bill:'+billId,payload:{billId},priority:55,maxAttempts:5})).created};
}

// Each routine cycle picks up bills it has not seen, watched bills once it may
// act, and waiting bills a saved limit now covers.
async function schedule(c,workspaceId,cycleId){
  const gate=await gates(c,workspaceId,{lock:false});
  if(!gate.draft)return {queued:false};
  const covered=!gate.blocked&&policy.permits(gate.account.plan,JOB,'automatic',{trained:true});
  const waiting=(await c.query(`SELECT 1 WHERE EXISTS(${discoverySql})
      OR ($3 AND EXISTS(SELECT 1 FROM ${bills} r WHERE r.workspace_id=$1 AND r.status='WATCHING'))
      OR ($4 AND EXISTS(SELECT 1 FROM ${bills} r JOIN ${rules} u ON u.workspace_id=r.workspace_id AND u.supplier_id=r.supplier_id AND u.category=r.category
        WHERE r.workspace_id=$1 AND r.status='REVIEW' AND r.chosen_by IS NULL AND u.enabled AND u.currency=r.currency AND r.amount_minor<=u.maximum_minor))`,
  [workspaceId,since(),!gate.watch,covered])).rowCount;
  if(!waiting)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:'landed-cost-bills:cycle:'+cycleId,payload:{cycleId},priority:55,maxAttempts:5});
  return {queued:true};
}

const rowSql=`SELECT r.*,b.bill_number,b.supplier_invoice_number,b.purchase_receipt_id AS bill_receipt_id,v.name AS supplier_name,
    l.description,l.landed_cost_kind,d.document_number,d.status AS document_status,
    rc.reference AS receipt_reference,rc.received_at,po.po_number,po.id AS purchase_order_id
  FROM ${bills} r JOIN accounting_supplier_bills b ON b.workspace_id=r.workspace_id AND b.id=r.bill_id
  JOIN accounting_supplier_bill_lines l ON l.workspace_id=r.workspace_id AND l.id=r.bill_line_id
  LEFT JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id
  LEFT JOIN landed_cost_documents d ON d.workspace_id=r.workspace_id AND d.id=r.document_id
  LEFT JOIN purchase_order_receipts rc ON rc.workspace_id=r.workspace_id AND rc.id=r.receipt_id
  LEFT JOIN purchase_orders po ON po.workspace_id=rc.workspace_id AND po.id=rc.purchase_order_id`;

async function load(c,ctx,lineId,{lock=false}={}){
  if(typeof lineId!=='string'||!lineId||lineId.length>160)throw new NotFoundError('That delivery cost is not in this inventory.');
  const row=(await c.query(rowSql+` WHERE r.workspace_id=$1 AND r.bill_line_id=$2 ${lock?'FOR UPDATE OF r':''}`,[ctx.workspaceId,lineId])).rows[0];
  if(!row)throw new NotFoundError('That delivery cost is not in this inventory.');
  return row;
}

// The owner approves one exact allocation. It counts as the example for this
// supplier or carrier and cost type.
async function approve(db,ctx,lineId,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const row=await load(c,ctx,lineId,{lock:true});
    if(row.status==='POSTED'&&!row.automatic&&row.decided_by===ctx.actorId)return {replayed:true};
    if(row.status!=='REVIEW'||row.document_status!=='DRAFT')throw new ValidationError('This bill is no longer waiting for your approval.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm this exact split.');
    const built=await costs.build(scoped(c),ctx,{id:row.document_id});
    if(input.fingerprint!==built.payload.fingerprint)throw new ValidationError('The delivery, the bill or the split changed. Review it again.');
    // Job 205: over the owner's amount two people approve it as a prepared change.
    if(await require('../autopilot/two-person-approval').landedCostWaiting(c,ctx,built.payload))return {twoPeople:true,documentId:row.document_id};
    const posted=await costs.applyInTransaction(c,ctx,built.payload);
    await c.query(`UPDATE ${bills} SET status='POSTED',automatic=false,decided_by=$3,decided_at=clock_timestamp(),reason=NULL,would_post=false,
      checked_at=clock_timestamp() WHERE workspace_id=$1 AND bill_line_id=$2`,[ctx.workspaceId,lineId,ctx.actorId]);
    return {posted:true,documentId:posted.documentId};
  });
}

// The owner leaves the bill as an expense. Nothing moves into stock cost.
async function keep(db,ctx,lineId,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,lineId,{lock:true});
    if(row.status==='KEPT')return {replayed:true};
    if(!OPEN.includes(row.status))throw new ValidationError('This bill is no longer waiting.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this bill stays an expense.');
    const voided=row.document_id&&row.document_status==='DRAFT';
    if(voided)await costs.voidDraft(scoped(c),ctx,row.document_id);
    await c.query(`UPDATE ${bills} SET status='KEPT',decided_by=$3,decided_at=clock_timestamp(),reason=NULL,would_post=false,checked_at=clock_timestamp(),
      document_id=CASE WHEN $4 THEN NULL ELSE document_id END,attempt=attempt+CASE WHEN $4 THEN 1 ELSE 0 END
      WHERE workspace_id=$1 AND bill_line_id=$2`,[ctx.workspaceId,lineId,ctx.actorId,Boolean(voided)]);
    await audit.record(c,ctx,{action:'Delivery cost kept as an expense',reference:row.bill_number,
      after:{billLineId:lineId,description:row.description,amount:money.format(Number(row.amount_minor),row.currency)}});
    return {kept:true};
  });
}

// The owner supplies what was missing: the delivery, the cost type or the split.
// The bill then waits for their approval; it never posts on its own.
async function choose(db,ctx,lineId,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,lineId,{lock:true});
    if(!OPEN.includes(row.status))throw new ValidationError('This bill is no longer waiting.');
    const receiptId=String(input.receiptId||row.receipt_id||''),category=String(input.category||row.category||''),method=input.method?String(input.method):null;
    if(!receiptId||!(await c.query('SELECT 1 FROM purchase_order_receipts WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,receiptId])).rowCount)
      throw new ValidationError('Choose a recorded delivery from this inventory.');
    if(!TYPES.includes(category))throw new ValidationError('Choose freight, duty, insurance or handling.');
    if(method&&!METHODS.includes(method))throw new ValidationError('Choose how to split the cost.');
    const voided=row.document_id&&row.document_status==='DRAFT';
    if(voided)await costs.voidDraft(scoped(c),ctx,row.document_id);
    await c.query(`UPDATE ${bills} SET receipt_id=$3,category=$4,method=$5,chosen_by=$6,checked_at=clock_timestamp(),
      document_id=CASE WHEN $7 THEN NULL ELSE document_id END,attempt=attempt+CASE WHEN $7 THEN 1 ELSE 0 END
      WHERE workspace_id=$1 AND bill_line_id=$2`,[ctx.workspaceId,lineId,receiptId,category,method,ctx.actorId,Boolean(voided)]);
    await audit.record(c,ctx,{action:'Delivery cost details chosen',reference:row.bill_number,
      before:{receiptId:row.receipt_id,costType:row.category,split:row.method},after:{billLineId:lineId,receiptId,costType:category,split:method}});
    const gate=await gates(c,ctx.workspaceId);
    if(!gate.draft)throw new ValidationError('Your plan does not prepare these allocations.');
    const bill=(await c.query(billSql,[ctx.workspaceId,row.bill_id])).rows[0];
    const line=(await c.query(lineSql+' AND l.id=$3',[ctx.workspaceId,row.bill_id,lineId])).rows[0];
    if(!line)throw new ValidationError('This bill line is no longer an expense.');
    const fresh=(await c.query(`SELECT * FROM ${bills} WHERE workspace_id=$1 AND bill_line_id=$2`,[ctx.workspaceId,lineId])).rows[0];
    return {status:await settle(c,gate,bill,line,fresh)};
  });
}

// Undo posts the reversing entry: the cost goes back to the expense it came from.
async function undo(db,ctx,lineId,input={}){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    const row=await load(c,ctx,lineId,{lock:true});
    if(row.status==='UNDONE')return {replayed:true};
    if(row.status!=='POSTED')throw new ValidationError('Only a posted allocation can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this cost goes back to the expense.');
    const reversed=await costs.reverse(scoped(c),ctx,row.document_id,{confirmed:'yes'});
    await c.query(`UPDATE ${bills} SET status='UNDONE',decided_by=$3,decided_at=clock_timestamp(),checked_at=clock_timestamp()
      WHERE workspace_id=$1 AND bill_line_id=$2`,[ctx.workspaceId,lineId,ctx.actorId]);
    await audit.record(c,ctx,{action:'Delivery cost taken back out of stock',reference:row.document_number,
      after:{bill:row.bill_number,amount:money.format(Number(row.amount_minor),row.currency),journalEntryId:reversed.journalEntryId,postedOnItsOwn:row.automatic}});
    return {undone:true};
  });
}

// The owner's limit for one supplier or carrier and cost type. On Pro it needs
// one allocation of that kind the owner approved themselves; Custom needs none.
async function configure(db,ctx,lineId,input={}){
  return tx(db,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic',{trained:true});
    const row=await load(c,ctx,lineId);
    if(!row.supplier_id||!row.category)throw new ValidationError('Choose the cost type for this bill first.');
    const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
    if(!currency)throw new ValidationError('Set up your accounting currency first.');
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND category=$3 FOR UPDATE`,
      [ctx.workspaceId,row.supplier_id,row.category])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current limit.');
    const scope={supplierId:row.supplier_id,supplier:row.supplier_name,costType:row.category};
    // Stopping keeps a row: every bill of this kind then waits for a person, on Custom too.
    if(input.stop==='yes'){
      if(!prior||prior.enabled){
        await c.query(`INSERT INTO ${rules} AS r(workspace_id,supplier_id,category,enabled,currency,maximum_minor,method,authorized_by)
          VALUES($1,$2,$3,false,$4,$5,$6,$7) ON CONFLICT(workspace_id,supplier_id,category) DO UPDATE SET enabled=false,
          authorized_by=excluded.authorized_by,revision=r.revision+1,updated_at=clock_timestamp()`,
        [ctx.workspaceId,row.supplier_id,row.category,prior?.currency||currency,prior?.maximum_minor||1,prior?.method||defaults[row.category],ctx.actorId]);
        await audit.record(c,ctx,{action:'Delivery cost limit stopped',reference:row.supplier_id,before:prior?{limit:money.format(Number(prior.maximum_minor),prior.currency)}:{},after:scope});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the limit for these bills.');
    const maximum=money.userToMinor(String(input.maximum??'').trim(),currency,{label:'Limit'});
    if(!(maximum>0))throw new ValidationError('Set a limit above zero.');
    const method=String(input.method||'');
    if(!METHODS.includes(method))throw new ValidationError('Choose how to split these bills.');
    const trained=policy.allowance(state.plan,JOB)==='trained';
    const taught=trained?await example(c,ctx.workspaceId,{supplierId:row.supplier_id,category:row.category,currency,personId:ctx.actorId}):null;
    if(trained&&!taught)throw new ValidationError('Approve one '+row.category+' bill from '+(row.supplier_name||'this supplier')+' yourself first.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const revision=(prior?.revision||0)+1;
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'landed-cost-rule:'+row.supplier_id+':'+row.category+':'+revision,4096,{finished:true});
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,supplier_id,category,currency,maximum_minor,method,authorized_by,example_document_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id,category) DO UPDATE SET enabled=true,currency=excluded.currency,
      maximum_minor=excluded.maximum_minor,method=excluded.method,authorized_by=excluded.authorized_by,example_document_id=excluded.example_document_id,
      revision=r.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,row.supplier_id,row.category,currency,maximum,method,ctx.actorId,taught?.id||null]);
    await audit.record(c,ctx,{action:'Delivery cost limit saved',reference:row.supplier_id,
      before:prior?{limit:money.format(Number(prior.maximum_minor),prior.currency),enabled:prior.enabled,split:prior.method}:{},
      after:{...scope,limit:money.format(maximum,currency),split:method,example:taught?.id||null}});
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'landed-cost-bills:rule:'+row.supplier_id+':'+row.category+':'+revision,
      payload:{},priority:55,maxAttempts:5});
    return {saved:true};
  });
}

// The owner can ask for every waiting and held bill to be checked again.
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:'landed-cost-bills:check:'+Math.floor(Date.now()/60000),
      payload:{recheck:true},priority:55,maxAttempts:5})).created};
  });
}

const labels={WATCHING:'Watching',REVIEW:'Waiting for you',HELD:'Needs your check',KEPT:'Kept as an expense',UNDONE:'Undone',HANDLED:'Allocated by hand'};
function label(row){return row.status==='POSTED'?(row.automatic?'Posted on its own':'Posted after your approval'):labels[row.status];}
function summary(row){
  return {id:row.bill_line_id,bill:row.bill_number,supplier:row.supplier_name||'Archived supplier',description:row.description,
    category:row.category,method:row.method,methodLabel:row.method?methodLabels[row.method]:null,status:row.status,label:label(row),reason:row.reason,
    wouldPost:row.would_post,automatic:row.automatic,amount:row.amount_minor==null?null:Number(row.amount_minor),currency:row.currency,
    receiptId:row.receipt_id,delivery:row.receipt_id?(row.po_number||'Delivery')+(row.receipt_reference?' · '+row.receipt_reference:''):null,
    document:row.document_id?{id:row.document_id,number:row.document_number}:null,href:path+'/'+encodeURIComponent(row.bill_line_id)};
}

async function page(db,ctx,{id=null,page:number=1}={}){
  const state=await access(db,ctx);
  const mode=policy.allowance(state.plan,JOB);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const gate=await gates(db,ctx.workspaceId,{lock:false});
  if(!id){
    const waiting=(await db.query(rowSql+` WHERE r.workspace_id=$1 AND r.status IN ('WATCHING','REVIEW','HELD')
      ORDER BY CASE r.status WHEN 'REVIEW' THEN 0 WHEN 'HELD' THEN 1 ELSE 2 END,r.checked_at,r.bill_line_id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
    const recent=(await db.query(rowSql+` WHERE r.workspace_id=$1 AND r.status IN ('POSTED','KEPT','UNDONE','HANDLED')
      ORDER BY r.decided_at DESC NULLS LAST,r.bill_line_id LIMIT 20`,[ctx.workspaceId])).rows;
    const saved=(await db.query(`SELECT r.*,v.name AS supplier_name FROM ${rules} r LEFT JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id
      WHERE r.workspace_id=$1 ORDER BY lower(coalesce(v.name,'')),r.category LIMIT 200`,[ctx.workspaceId])).rows;
    return {mode,stop:gate.watch||gate.blocked||null,waiting:waiting.slice(0,50).map(summary),more:waiting.length>50,page:number,
      recent:recent.map(summary),rules:saved.map(r=>({supplier:r.supplier_name||'Archived supplier',category:r.category,enabled:r.enabled,
        limit:money.format(Number(r.maximum_minor),r.currency),methodLabel:methodLabels[r.method]}))};
  }
  const row=await load(db,ctx,id),item=summary(row);
  let preview=null,problem=null;
  if(row.status==='REVIEW'&&row.document_status==='DRAFT'){
    try{const p=await costs.preview(db,ctx,row.document_id);preview={fingerprint:p.fingerprint,allocations:p.source.allocations.map(a=>({product:a.product,sku:a.sku,
      quantity:a.quantity,location:a.location,amount:a.amountMinor}))};}
    catch(error){if(error.code!=='validation_error')throw error;problem=plain(error.message);}
  }
  const posted=row.document_id&&['POSTED','UNDONE'].includes(row.status)?(await db.query(`SELECT a.amount_minor,s.code,i.name,l.name AS location_name
    FROM landed_cost_allocations a JOIN skus s ON s.workspace_id=a.workspace_id AND s.id=a.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=a.workspace_id AND l.id=a.location_id WHERE a.workspace_id=$1 AND a.document_id=$2 ORDER BY s.code,a.id`,
  [ctx.workspaceId,row.document_id])).rows.map(a=>({product:a.name,sku:a.code,location:a.location_name,amount:Number(a.amount_minor)})):[];
  let undoable=false,undoReason=null;
  if(row.status==='POSTED'){
    try{await costs.receiptFacts(db,ctx,[row.receipt_id],row.purchase_order_id);undoable=true;}
    catch(error){if(error.code!=='validation_error')throw error;undoReason=plain(error.message);}
  }
  const deliveries=OPEN.includes(row.status)?(await db.query(`SELECT r.id,r.reference,r.received_at,po.po_number FROM purchase_order_receipts r
    JOIN purchase_orders po ON po.workspace_id=r.workspace_id AND po.id=r.purchase_order_id
    WHERE r.workspace_id=$1 ORDER BY (r.id=$2) DESC,r.received_at DESC,r.id DESC LIMIT 50`,[ctx.workspaceId,row.receipt_id||''])).rows:[];
  const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium'});
  const rule=row.supplier_id&&row.category?await ruleFor(db,ctx.workspaceId,row.supplier_id,row.category):null;
  const trained=mode==='trained',canTeach=Boolean(row.supplier_id&&row.category&&gate.book&&
    (!trained||await example(db,ctx.workspaceId,{supplierId:row.supplier_id,category:row.category,currency:gate.book,personId:ctx.actorId})));
  const taught=rule?.enabled&&rule.current&&(!trained||Boolean(rule.example_document_id&&await example(db,ctx.workspaceId,{supplierId:row.supplier_id,
    category:row.category,currency:rule.currency,personId:rule.authorized_by,documentId:rule.example_document_id})));
  return {mode,item,preview,problem,posted,undoable,undoReason,stop:gate.watch||null,
    deliveries:deliveries.map(d=>({id:d.id,label:d.po_number+' · '+(d.reference||clock.format(new Date(d.received_at)))})),
    types:TYPES,methods:METHODS.map(m=>({value:m,label:methodLabels[m]})),
    rule:rule&&{enabled:rule.enabled,revision:rule.revision,current:rule.current,maximum:money.fromMinor(Number(rule.maximum_minor),rule.currency),
      limit:money.format(Number(rule.maximum_minor),rule.currency),method:rule.method,methodLabel:methodLabels[rule.method]},
    trained,canTeach,taught:Boolean(taught),defaultMethod:row.method||(row.category?defaults[row.category]:'quantity')};
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!included(account))return [];
  const rows=(await db.query(`SELECT r.bill_line_id,r.status,r.reason,r.category,r.checked_at,b.bill_number,v.name AS supplier
    FROM ${bills} r JOIN accounting_supplier_bills b ON b.workspace_id=r.workspace_id AND b.id=r.bill_id
    LEFT JOIN suppliers v ON v.workspace_id=r.workspace_id AND v.id=r.supplier_id
    WHERE r.workspace_id=$1 AND r.status IN ('REVIEW','HELD') ORDER BY r.checked_at,r.bill_line_id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'accounting',importance:'Needs You',priority:70,
    title:(r.category?r.category[0].toUpperCase()+r.category.slice(1):'Delivery cost')+' bill '+r.bill_number+' from '+(r.supplier||'a supplier')+' needs you',
    happened:r.reason||'',why:'Bills not matched to one delivery, over your limit, in another currency, or for goods already sold always wait for a person.',
    recommendation:r.status==='REVIEW'?'Check the split over the delivery and approve it.':'Choose what is missing, or keep it as an expense.',
    href:path+'/'+encodeURIComponent(r.bill_line_id),actionLabel:'Review delivery cost',sourceId:'landed-cost-bill:'+r.bill_line_id,at:r.checked_at,createdAt:r.checked_at}));
}

module.exports={kind,path,queue,schedule,run,approve,keep,choose,undo,configure,check,page,inbox,costType};
