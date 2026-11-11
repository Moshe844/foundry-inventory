'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions');
const action='customer_invoice.prepare_document',scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
async function owner(db,ctx,lock=false){
 const r=await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
 if(!r.rowCount)throw new AuthorizationError('Only the current inventory owner can prepare or read customer invoice paperwork.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}
async function authority(db,ctx,automatic=false){
 await owner(db,ctx,true);await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,101,'draft');
 const stop=await policy.stopped(db,ctx.workspaceId,state,action,automatic);if(stop)throw new ValidationError(stop);
 if(automatic){const mode=(await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId])).rows[0];
  if(mode?.mode!=='POLICY_AUTOMATED'||Number(mode.paused)||Number(mode.suspended))throw new ValidationError('Automatic invoice paperwork needs current routine authority.');}
 return state;
}
const customerHash=c=>hash({name:c.name,company:c.company,email:c.email,shipping_address:c.shipping_address});
async function facts(db,ctx,id){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,101,'draft');
 // The canonical lock serializes this read with fulfillment, credits and receipts.
 const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,id])).rows[0];
 if(!invoice?.sales_order_id||['DRAFT','VOID'].includes(invoice.status))throw new ValidationError('Choose a posted customer invoice from an actually fulfilled sales order.');
 const order=(await db.query('SELECT order_number,customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,invoice.sales_order_id])).rows[0];
 const customer=(await db.query('SELECT name,company,email,shipping_address,record_state FROM customers WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,invoice.customer_id])).rows[0];
 if(!order||order.customer_id!==invoice.customer_id||customer?.record_state!=='ACTIVE')throw new ValidationError('Review the invoice’s customer and source order before preparing its paperwork.');
 const events=(await db.query("SELECT id,created_at,detail::jsonb FROM sales_order_events WHERE workspace_id=$1 AND sales_order_id=$2 AND event_type='fulfilled' ORDER BY created_at,id",[ctx.workspaceId,invoice.sales_order_id])).rows;
 if(!events.length||events.some(e=>!Array.isArray(e.detail?.lines)||!e.detail.lines.length))throw new ValidationError('The original physical fulfillment confirmation is missing. Review this invoice individually.');
 const company=await require('../operations/postgres-company-profile').get(db,ctx.workspaceId);
 if(!company.revision||![company.legalName,company.addressLine1,company.city,company.country].every(Boolean))throw new ValidationError('Complete the legal company name and address in Company settings before preparing customer invoices.');
 if(!invoice.due_date)throw new ValidationError('Confirm the invoice’s agreed due date first. Current payment terms cannot establish historical terms.');
 const document=await require('./postgres-invoice-document').load(db,ctx.workspaceId,id);
 // Customer paperwork carries the saved due date, never a new current credit term.
 document.dueDate=invoice.due_date;document.dueInferred=false;document.terms='Payment due '+invoice.due_date;delete document.hash;
 const units=new Map((await db.query('SELECT s.id,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])',[ctx.workspaceId,[...new Set(document.lines.map(l=>l.sku_id).filter(Boolean))]])).rows.map(r=>[r.id,r.unit_label]));
 document.lines=document.lines.map(l=>{const pricing=typeof l.pricing_snapshot==='string'?JSON.parse(l.pricing_snapshot):l.pricing_snapshot||{};return {...l,document_quantity:pricing.secondaryQuantity!=null?l.document_quantity:String(l.quantity)+(units.get(l.sku_id)?' '+units.get(l.sku_id):'')};});
 const movements=(await db.query(`WITH fulfilled AS(SELECT jsonb_array_elements(detail::jsonb->'lines') l FROM sales_order_events WHERE workspace_id=$1 AND sales_order_id=$2 AND event_type='fulfilled'), ids AS(SELECT l->>'movementId' id FROM fulfilled UNION SELECT c->>'movementId' FROM fulfilled CROSS JOIN LATERAL jsonb_array_elements(coalesce(l->'kitComponents','[]')) c)
 SELECT m.id,m.occurred_at,m.quantity_delta,s.code sku,i.name description,s.variant_label,i.unit_label,l.name location,lot.code lot,
 coalesce((SELECT jsonb_agg(u.serial ORDER BY u.serial,u.id) FROM stockchief_runtime.inventory_movement_serial_units x JOIN serial_units u ON u.workspace_id=x.workspace_id AND u.id=x.serial_unit_id WHERE x.workspace_id=m.workspace_id AND x.movement_id=m.id),'[]'::jsonb) serials,
 unit.serial serial FROM ids JOIN movements m ON m.workspace_id=$1 AND m.id=ids.id JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id LEFT JOIN lots lot ON lot.workspace_id=m.workspace_id AND lot.id=m.lot_id LEFT JOIN serial_units unit ON unit.workspace_id=m.workspace_id AND unit.id=m.serial_unit_id ORDER BY m.occurred_at,m.id`,[ctx.workspaceId,invoice.sales_order_id])).rows;
 const fulfillments=events.map(event=>({id:event.id,date:event.created_at,lines:event.detail.lines.map(line=>({
  skuId:line.skuId,description:line.description,quantity:line.quantity,secondaryQuantity:line.secondaryQuantity,priceUnitLabel:line.priceUnitLabel,
  ...(line.supplierDirect?{supplierDirect:{carrier:line.supplierDirect.carrier,trackingNumber:line.supplierDirect.trackingNumber,
   shippedAt:line.supplierDirect.shippedAt,lots:line.supplierDirect.lots,serials:line.supplierDirect.serials}}:{})
 }))}));
 const result={document,orderNumber:order.order_number,customerHash:customerHash(customer),fulfillments,movements};
 return {...result,sourceHash:hash(result)};
}
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(p){const d=p.document,r=d.row,amount=n=>escape(money.format(money.integer(n??0,'Invoice amount',{signed:true}),r.currency));
 const directLines=(p.fulfillments||[]).flatMap(event=>event.lines.filter(line=>line.supplierDirect));
 const directDetails=directLines.length?'<h3>Confirmed supplier dispatch details</h3><ul>'+directLines.map(line=>{
  const direct=line.supplierDirect;
  return '<li>'+escape(line.description)+' · '+escape(line.quantity)+' · '+escape(direct.carrier)+' '+escape(direct.trackingNumber)+
   ' · '+escape(direct.shippedAt)+(line.secondaryQuantity==null?'':' · '+escape(line.secondaryQuantity+' '+line.priceUnitLabel))+
   (direct.lots.length?' · Batches '+escape(direct.lots.map(lot=>lot.lotCode+' ('+lot.quantity+')').join(', ')):'')+
   (direct.serials.length?' · Serials '+escape(direct.serials.map(unit=>unit.serial).join(', ')):'')+'</li>';
 }).join('')+'</ul>':'';
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice '+escape(r.invoice_number)+'</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#172033;max-width:900px;margin:24px auto;padding:16px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}.number{text-align:right}address{white-space:pre-line;font-style:normal}.totals{max-width:390px;margin-left:auto}small{color:#596174}.scroll{overflow:auto}@media print{button{display:none}body{margin:0;max-width:none;padding:0}tr{break-inside:avoid}thead{display:table-header-group}.scroll{overflow:visible}}</style></head><body><button onclick="window.print()">Print / save PDF</button><h1>'+escape(d.issuer)+'</h1><address>'+escape(d.issuerAddress)+'</address><h2>Invoice '+escape(r.invoice_number)+'</h2><p>Order '+escape(p.orderNumber)+' · Issued '+escape(r.issue_date)+' · Due '+escape(d.dueDate)+' · '+escape(r.currency)+'</p><h3>Bill to</h3><address>'+escape(d.customer.company||d.customer.name)+(d.customer.company?'\n'+escape(d.customer.name):'')+'\n'+escape(d.customer.shipping_address||'')+'\n'+escape(d.customer.email||'')+'</address><p>'+escape(d.terms)+'</p><div class="scroll"><table><thead><tr><th>Product / variant</th><th>Quantity</th><th class="number">Unit price</th><th class="number">Original amount</th></tr></thead><tbody>'+d.lines.map(l=>'<tr><td>'+escape(l.description)+'</td><td>'+escape(l.document_quantity||l.quantity)+'</td><td class="number">'+amount(l.unit_price_minor)+'</td><td class="number">'+amount(l.document_amount_minor??l.line_total_minor)+'</td></tr>').join('')+'</tbody></table></div>'+
 (d.credits.length?'<p>Original invoice lines are retained. Posted return credits:</p><ul>'+d.credits.map(c=>'<li>'+escape(c.return_number)+': '+amount(Number(c.revenue_minor)+Number(c.tax_minor))+'</li>').join('')+'</ul>':'')+
 '<table class="totals">'+[['Current subtotal',r.subtotal_minor],['Discount',-Number(r.discount_minor)],['Tax',r.tax_minor],['Charges',r.charges_minor||0],['Invoice total',r.total_minor],['Balance due',r.balance_minor]].map(([label,n])=>'<tr><th>'+label+'</th><td class="number">'+amount(n)+'</td></tr>').join('')+'</table>'+
 directDetails+(p.movements.length?'<h3>Confirmed dispatch details</h3><ul>'+p.movements.map(m=>'<li>'+escape(m.description)+(m.variant_label?' — '+escape(m.variant_label):'')+' ('+escape(m.sku)+') · '+escape(String(m.quantity_delta).replace(/^-/,'')+' '+m.unit_label)+' from '+escape(m.location)+' · '+escape(m.occurred_at)+(m.lot?' · Lot '+escape(m.lot):'')+([...new Set([m.serial,...m.serials].filter(Boolean))].length?' · Serials '+escape([...new Set([m.serial,...m.serials].filter(Boolean))].join(', ')):'')+'</li>').join('')+'</ul>':'')+
 (r.notes?'<p>'+escape(r.notes)+'</p>':'')+'<footer><small>Prepared with StockChief from posted records updated '+escape(r.updated_at)+'. This private copy is not a second invoice or a payment request sent by StockChief.</small><p><a href="/money/invoices/'+escape(r.id)+'">Check the current posted invoice and balance</a></p></footer></body></html>';
}
async function taught(db,ctx,p,maximum){return Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.agent_customer_invoice_documents d JOIN stockchief_runtime.agent_customer_invoice_examples e ON e.workspace_id=d.workspace_id AND e.document_id=d.id WHERE d.workspace_id=$1 AND e.owner_id=$2 AND source_snapshot->'document'->'row'->>'customer_id'=$3 AND source_snapshot->'document'->'row'->>'currency'=$4 AND source_snapshot->>'customerHash'=$5 AND (source_snapshot->'document'->'row'->>'total_minor')::numeric>=$6 LIMIT 1`,[ctx.workspaceId,ctx.actorId,p.document.row.customer_id,p.document.row.currency,p.customerHash,maximum])).rowCount);}
async function save(db,ctx,p,{automatic=false}={}){
 await db.query('SELECT id FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,p.recordId||p.document.row.id]);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['customer-invoice:'+ctx.workspaceId+':'+(p.recordId||p.document.row.id)]);
 const state=await authority(db,ctx,automatic),fresh=await facts(db,ctx,p.recordId||p.document.row.id);
 if(p.sourceHash&&p.sourceHash!==fresh.sourceHash)throw new ValidationError('The posted invoice, customer, dispatch or company details changed. Review the current invoice.');
 if(automatic){const r=(await db.query('SELECT * FROM stockchief_runtime.agent_customer_invoice_rules WHERE workspace_id=$1 AND customer_id=$2 AND currency=$3 FOR SHARE',[ctx.workspaceId,fresh.document.row.customer_id,fresh.document.row.currency])).rows[0];
  if(!r||r.authorized_by!==ctx.actorId)throw new ValidationError('The current owner has not enabled this customer’s invoice routine.');
  if(r.customer_hash!==fresh.customerHash)throw new ValidationError('Customer details changed. Confirm the customer again before routine paperwork.');
  if(Number(fresh.document.row.total_minor)>Number(r.maximum_minor))throw new ValidationError('The invoice exceeds the owner’s saved invoice limit. Prepare it individually.');
  policy.requireJob(state.plan,101,'automatic',{trained:state.plan!=='growth'||await taught(db,ctx,fresh,Number(r.maximum_minor))});
 }
 const prior=(await db.query('SELECT id FROM stockchief_runtime.agent_customer_invoice_documents WHERE workspace_id=$1 AND invoice_id=$2 AND source_hash=$3',[ctx.workspaceId,fresh.document.row.id,fresh.sourceHash])).rows[0];
 if(prior){if(!automatic)await example(db,ctx,prior.id);return {id:prior.id,invoiceId:fresh.document.row.id,href:'/autopilot/customer-invoices/'+prior.id,replayed:true};}
 const html=render(fresh),id='invoice_document_'+hash({workspaceId:ctx.workspaceId,invoiceId:fresh.document.row.id,sourceHash:fresh.sourceHash});await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'customer-invoice:'+fresh.document.row.id+':'+fresh.sourceHash,Buffer.byteLength(html)+Buffer.byteLength(JSON.stringify(fresh))+8192,{finished:true});
 await db.query('INSERT INTO stockchief_runtime.agent_customer_invoice_documents(id,workspace_id,invoice_id,owner_id,automatic,source_hash,source_snapshot,html) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,invoice_id,source_hash) DO NOTHING',[id,ctx.workspaceId,fresh.document.row.id,ctx.actorId,automatic,fresh.sourceHash,JSON.stringify(fresh),html]);
 if(!automatic)await example(db,ctx,id);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer invoice paperwork prepared',reference:fresh.document.row.invoice_number,after:{automatic,invoiceId:fresh.document.row.id,documentId:id}});
 return {id,invoiceId:fresh.document.row.id,href:'/autopilot/customer-invoices/'+id};
}
async function example(db,ctx,id){await db.query('INSERT INTO stockchief_runtime.agent_customer_invoice_examples(workspace_id,document_id,owner_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.workspaceId,id,ctx.actorId]);}
async function configure(database,ctx,input){return database.transaction(async db=>{
 await owner(db,ctx,true);const revision=Number(input.revision);if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the current customer invoice settings.');
 const currency=money.code(input.currency),ref=String(input.customerId||input.customerReference||'').trim();
 const customers=(await db.query("SELECT id,name,company,email,shipping_address,record_state FROM customers WHERE workspace_id=$1 AND (id=$2 OR lower(name)=lower($2) OR lower(email)=lower($2)) ORDER BY id LIMIT 2 FOR SHARE",[ctx.workspaceId,ref])).rows;
 if(customers.length!==1)throw new ValidationError('Choose one exact customer name or email.');const c=customers[0];
 const prior=(await db.query('SELECT * FROM stockchief_runtime.agent_customer_invoice_rules WHERE workspace_id=$1 AND customer_id=$2 AND currency=$3 FOR UPDATE',[ctx.workspaceId,c.id,currency])).rows[0];
 if(Number(prior?.revision||0)!==revision)throw new ValidationError('This customer invoice rule changed. Reload before saving.');
 if(input.remove==='1'){await db.query('DELETE FROM stockchief_runtime.agent_customer_invoice_rules WHERE workspace_id=$1 AND customer_id=$2 AND currency=$3',[ctx.workspaceId,c.id,currency]);await db.query('UPDATE stockchief_runtime.agent_customer_invoice_work w SET completed_revision=revision,problem=NULL,retry_after=NULL FROM accounting_customer_invoices i WHERE i.workspace_id=w.workspace_id AND i.id=w.invoice_id AND i.workspace_id=$1 AND i.customer_id=$2 AND i.currency=$3',[ctx.workspaceId,c.id,currency]);await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer invoice routine stopped',reference:c.name,after:{currency}});return {stopped:true};}
 if(c.record_state!=='ACTIVE')throw new ValidationError('Choose a currently active customer before enabling invoice paperwork.');
 const state=await authority(db,ctx),maximum=money.userToMinor(input.maximum,currency);
 if(maximum<=0||input.confirmed!=='yes')throw new ValidationError('Confirm this exact customer and authorize a positive invoice total limit.');
 if(!(await db.query("SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND confirmed_at IS NOT NULL AND coalesce(customer_decision_required,0)=0 LIMIT 1",[ctx.workspaceId,c.id])).rowCount)throw new ValidationError('Individually confirm this customer’s first order before enabling invoice paperwork.');
 const p={document:{row:{customer_id:c.id,currency}},customerHash:customerHash(c)};
 policy.requireJob(state.plan,101,'automatic',{trained:state.plan!=='growth'||await taught(db,ctx,p,maximum)});
 await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?0:1);
 await db.query(`INSERT INTO stockchief_runtime.agent_customer_invoice_rules(workspace_id,customer_id,currency,maximum_minor,customer_hash,authorized_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,customer_id,currency) DO UPDATE SET maximum_minor=$4,customer_hash=$5,authorized_by=$6,revision=agent_customer_invoice_rules.revision+1`,[ctx.workspaceId,c.id,currency,maximum,p.customerHash,ctx.actorId]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer invoice routine authorized',reference:c.name,after:{currency,maximum:money.format(maximum,currency)}});return {enabled:true};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function work(database,workspaceId,invoiceId){return database.transaction(async db=>{
 await db.query('SELECT id FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,invoiceId]);
 const w=(await db.query('SELECT * FROM stockchief_runtime.agent_customer_invoice_work WHERE workspace_id=$1 AND invoice_id=$2 FOR UPDATE',[workspaceId,invoiceId])).rows[0];
 if(!w||Number(w.completed_revision)>=Number(w.revision))return {replayed:true};
 await db.query('SAVEPOINT customer_invoice_document');
 try{const rule=(await db.query('SELECT r.authorized_by FROM stockchief_runtime.agent_customer_invoice_rules r JOIN accounting_customer_invoices i ON i.workspace_id=r.workspace_id AND i.customer_id=r.customer_id AND i.currency=r.currency WHERE i.workspace_id=$1 AND i.id=$2',[workspaceId,invoiceId])).rows[0];
  if(!rule)throw new ValidationError('The customer invoice routine is stopped.');
  const result=await save(db,{workspaceId,actorId:rule.authorized_by},{recordId:invoiceId},{automatic:true});
  await db.query('UPDATE stockchief_runtime.agent_customer_invoice_work SET completed_revision=revision,problem=NULL,retry_after=NULL WHERE workspace_id=$1 AND invoice_id=$2',[workspaceId,invoiceId]);await db.query('RELEASE SAVEPOINT customer_invoice_document');return result;
 }catch(error){if(!['validation_error','forbidden','entitlement_required'].includes(error.code))throw error;
  await db.query('ROLLBACK TO SAVEPOINT customer_invoice_document');await db.query('RELEASE SAVEPOINT customer_invoice_document');
  await db.query("UPDATE stockchief_runtime.agent_customer_invoice_work SET problem=$3,retry_after=now()+interval '15 minutes' WHERE workspace_id=$1 AND invoice_id=$2",[workspaceId,invoiceId,error.message]);return {held:true,reason:error.message};}
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function schedule(db,workspaceId){const rows=(await db.query(`SELECT invoice_id FROM stockchief_runtime.agent_customer_invoice_work WHERE workspace_id=$1 AND revision>completed_revision AND (retry_after IS NULL OR retry_after<=now()) ORDER BY changed_at,invoice_id LIMIT 50`,[workspaceId])).rows;let queued=0;
 for(const r of rows){const result=await require('../operations/postgres-job-queue').enqueue(db.transaction?db:scoped(db),{workspaceId,kind:'agent.customer-invoice',payload:{invoiceId:r.invoice_id},idempotencyKey:r.invoice_id+':check:'+Math.floor(Date.now()/60000),priority:65,maxAttempts:8});queued+=Number(result.created);}return {queued};}
async function document(db,ctx,id){await owner(db,ctx);const row=(await db.query('SELECT * FROM stockchief_runtime.agent_customer_invoice_documents WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That customer invoice copy is unavailable.');return row;}
async function page(db,ctx,input={}){await owner(db,ctx);const page=Number(input.page||1);if(!Number.isSafeInteger(page)||page<1)throw new ValidationError('Choose a valid invoice page.');const offset=(page-1)*50,account=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(account)&&policy.permits(account.plan,101,'draft');
 const recent=(await db.query(`SELECT p.id,p.automatic,p.created_at,p.invoice_id,p.source_snapshot->'document'->'row'->>'invoice_number' invoice_number,p.source_snapshot->'document'->'customer'->>'name' customer_name,EXISTS(SELECT 1 FROM stockchief_runtime.agent_customer_invoice_documents newer WHERE newer.workspace_id=p.workspace_id AND newer.invoice_id=p.invoice_id AND (newer.created_at,newer.id)>(p.created_at,p.id)) superseded FROM stockchief_runtime.agent_customer_invoice_documents p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 51 OFFSET $2`,[ctx.workspaceId,offset])).rows;
 const rules=(await db.query(`SELECT r.*,c.name customer_name FROM stockchief_runtime.agent_customer_invoice_rules r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id WHERE r.workspace_id=$1 ORDER BY c.name,c.id,r.currency LIMIT 51 OFFSET $2`,[ctx.workspaceId,offset])).rows;
 const held=(await db.query(`SELECT w.problem,i.invoice_number FROM stockchief_runtime.agent_customer_invoice_work w JOIN accounting_customer_invoices i ON i.workspace_id=w.workspace_id AND i.id=w.invoice_id WHERE w.workspace_id=$1 AND w.revision>w.completed_revision ORDER BY w.changed_at,w.invoice_id LIMIT 51 OFFSET $2`,[ctx.workspaceId,offset])).rows;
 return {allowed,blocked:allowed?await policy.stopped(db,ctx.workspaceId,account,action,false):'Customer invoice automation requires Growth, Pro or Custom.',recent:recent.slice(0,50),rules:rules.slice(0,50).map(r=>({...r,maximum:money.fromMinor(r.maximum_minor,r.currency)})),held:held.slice(0,50),page,more:[recent,rules,held].some(r=>r.length>50)};
}
function notices(row){if(!row?.n)return [];return [{kind:'accounting',importance:'Needs You',priority:45,title:row.n+' customer invoice'+(row.n===1?' is':'s are')+' waiting',happened:'Posted dispatch invoices are queued or held for private paperwork preparation.',why:'Open the invoice queue to review changed customer details, limits or current authority.',actionLabel:'Review invoice paperwork',href:'/autopilot/customer-invoices',sourceId:'customer-invoice-paperwork',createdAt:row.created_at,at:row.created_at}];}
module.exports={notices,owner,facts,render,save,configure,work,schedule,document,page,action,definition:{id:101,key:'customer-invoices',label:'Customer invoices after shipment',readPage:async()=>({summary:'Prepare and print posted shipment invoices, or enable customer routines with exact limits. Growth learns from completed individual paperwork. Pro and Custom need no teaching. Physical handoff, financial approval and sending stay separate.',rows:[{Review:'Open customer invoice paperwork',link:'/autopilot/customer-invoices'}]})},spec:{name:action,agentJob:101,record:'customer_invoice',fields:['recordReference'],permission:require('../actions/permissions').OPERATE,ownerOnly:true,capability:'accounting.core',resultingRecords:['stockchief_runtime.agent_customer_invoice_documents'],description:'Prepare a private, printable customer invoice from a posted native shipment invoice, with its exact goods, currency, agreed due date, partial dispatches and posted return credits. Creates no receivable, stock movement or message. Individual approval can teach Growth; automatic paperwork requires separate explicit owner customer settings.',build:async(db,ctx,row)=>{const p=await facts(db,ctx,row.id);return {payload:{recordId:row.id,sourceHash:p.sourceHash},summary:'Prepare printable invoice '+p.document.row.invoice_number+' for '+p.document.customer.name+', '+money.format(Number(p.document.row.total_minor),p.document.row.currency)+'. Uses posted dispatch, credits and the saved due date. No money, stock or message is created.'};},execute:(db,ctx,p)=>save(db,ctx,p),verify:async(db,ctx,r,p)=>Boolean((await db.query('SELECT 1 FROM stockchief_runtime.agent_customer_invoice_documents WHERE workspace_id=$1 AND id=$2 AND invoice_id=$3 AND source_hash=$4',[ctx.workspaceId,r.id,p.recordId,p.sourceHash])).rowCount)}};
