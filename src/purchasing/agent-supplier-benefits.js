'use strict';
const policy=require('../commercial/agent-plan'),calculator=require('./supplier-rebate-calculation'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions'),{newId}=require('../lib/util'),{ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
function day(value,label,{optional=false}={}){if(optional&&!value)return null;const text=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text)throw new ValidationError('Confirm a real '+label+'.');return text;}
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can record supplier benefit agreements.');
 require('../actions/permissions').assertCan(user,require('../actions/permissions').VIEW_ACCOUNTING,'review supplier benefit records');return user;
}
async function access(db,ctx,operation){await owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,97,operation);}
async function lockPlan(c,ctx){await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);return access(c,ctx,'draft');}
async function get(db,workspaceId,id,{lock=false}={}){
 const row=(await db.query('SELECT *,starts_on::text,ends_on::text,claim_on::text,claim_by::text FROM stockchief_runtime.agent_supplier_benefit_programs WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('That supplier benefit agreement is not in this inventory.');return row;
}
async function products(db,workspaceId,supplierId,skuIds){
 if(!Array.isArray(skuIds)||skuIds.length>250||new Set(skuIds).size!==skuIds.length)throw new ValidationError('Choose distinct exact products for this agreement.');
 const rows=skuIds.length?(await db.query(`SELECT s.id,s.code,i.unit_label,i.quantity_precision FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1
   AND EXISTS(SELECT 1 FROM supplier_items si WHERE si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.supplier_id=$3 AND si.is_active=1) ORDER BY s.id`,[workspaceId,skuIds,supplierId])).rows:[];
 if(rows.length!==skuIds.length)throw new ValidationError('Choose active products already linked to this known supplier.');
 return rows.map(row=>({skuId:row.id,code:row.code,unit:row.unit_label,precision:Number(row.quantity_precision)}));
}
function formTerms(input){
 if(input.terms)return calculator.normalize(input.terms);
 const currency=money.code(input.currency),rows=String(input.tiersText||'').trim().split(/\r?\n/).map(line=>line.split('|').map(value=>value.trim()));
 const tiers=rows.map(parts=>{
  if(parts.length!==2)throw new ValidationError('Use one agreed tier per line: threshold | percentage or agreed price.');
  const threshold=input.basis==='net_spend'?String(money.userToMinor(parts[0],currency,{label:'Spend threshold'})):parts[0];
  if(input.benefit==='percentage'){
   if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(parts[1]))throw new ValidationError('Enter the agreed percentage with no more than two decimal places.');
   const [whole,fraction='']=parts[1].split('.');return {threshold,rateBasisPoints:Number(whole)*100+Number(fraction.padEnd(2,'0'))};
  }
  return {threshold,unitPriceMinor:String(money.userToMinor(parts[1],currency,{label:'Agreed price'}))};
 });
 return calculator.normalize({basis:input.basis,benefit:input.benefit,method:input.method,rounding:input.rounding,pricePerUnits:input.pricePerUnits,tiers});
}
async function definition(db,ctx,input,supplierId=input.supplierId){
 if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact terms already agreed with this supplier. Recording an agreement does not accept new terms or approve any payment, credit or price change.');
 const title=String(input.title||'').trim(),reference=String(input.sourceReference||'').trim(),currency=money.code(input.currency),start=day(input.startsOn,'agreement start date'),end=day(input.endsOn,'agreement end date'),claimOn=day(input.claimOn,'claim opening date',{optional:true}),claimBy=day(input.claimBy,'claim deadline',{optional:true});
 if(!title||title.length>200||!reference||reference.length>500||start>end||claimOn&&claimOn<start||claimBy&&(!claimOn||claimBy<claimOn))throw new ValidationError('Confirm the agreement name, original source reference, purchase period and claim dates.');
 const supplier=(await db.query("SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,supplierId])).rows[0];if(!supplier)throw new ValidationError('Choose an active known supplier.');
 const terms=formTerms(input),selected=await products(db,ctx.workspaceId,supplier.id,[].concat(input.skuIds||[])),allProducts=input.allProducts==='yes';
 if(allProducts&&selected.length)throw new ValidationError('Choose either all matched products or exact SKU codes, not both.');
 if(terms.basis==='stock_units'&&(allProducts||selected.length!==1))throw new ValidationError('Quantity tiers need one exact product and its recorded stock unit.');
 if(terms.basis==='net_spend'&&!selected.length&&!allProducts)throw new ValidationError('Select exact products or explicitly authorize all matched product lines for this supplier.');
 return {supplier_id:supplier.id,title,source_reference:reference,currency,starts_on:start,ends_on:end,claim_on:claimOn,claim_by:claimBy,terms,scope:{supplierId:supplier.id,supplierName:supplier.name,supplierEmail:supplier.email,allProducts,products:selected}};
}
async function configure(db,ctx,input){
 return db.transaction(async c=>{
  await owner(c,ctx);const prior=input.id?await get(c,ctx.workspaceId,input.id,{lock:true}):null;
  if((prior?.revision||0)!==Number(input.revision||0))throw new ValidationError('Reload the current agreement before changing it.');
  if(input.stop==='yes'){if(!prior)throw new ValidationError('Choose an existing agreement to stop.');await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_programs SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,prior.id]);await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier benefit tracking stopped',reference:prior.id});return {id:prior.id};}
  await lockPlan(c,ctx);
  if(input.resume==='yes'){
   if(!prior||input.confirmed!=='yes')throw new ValidationError('Confirm resuming this exact existing supplier agreement.');const f=await facts(c,ctx,prior.id);
   if(f.scopeReview||input.expectedFingerprint!==f.sourceFingerprint)throw new ValidationError('Review the current supplier, product scope and original agreed terms before resuming tracking.');
   await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_programs SET enabled=true,authorized_by=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,prior.id,ctx.actorId]);
   await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_observations SET needs_review=false,observed_at='epoch' WHERE workspace_id=$1 AND program_id=$2",[ctx.workspaceId,prior.id]);
   await require('../operations/postgres-security-audit').record(c,ctx,{action:'Existing supplier benefit tracking resumed',reference:prior.id});return {id:prior.id};
  }
  const d=await definition(c,ctx,input,prior?.supplier_id||input.supplierId),{title,source_reference:reference,currency,starts_on:start,ends_on:end,claim_on:claimOn,claim_by:claimBy,scope,terms}=d,id=prior?.id||newId('supplier-benefit');
  if(prior&&(await c.query('SELECT 1 FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 LIMIT 1',[ctx.workspaceId,id])).rowCount)throw new ValidationError('This agreement already has claim history. Preserve it and record revised contract terms as a separate agreement.');
  await c.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_programs(id,workspace_id,supplier_id,title,source_reference,currency,starts_on,ends_on,claim_on,claim_by,scope,terms,authorized_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,source_reference=EXCLUDED.source_reference,currency=EXCLUDED.currency,starts_on=EXCLUDED.starts_on,ends_on=EXCLUDED.ends_on,claim_on=EXCLUDED.claim_on,claim_by=EXCLUDED.claim_by,scope=EXCLUDED.scope,terms=EXCLUDED.terms,authorized_by=EXCLUDED.authorized_by,revision=agent_supplier_benefit_programs.revision+1,updated_at=now()`,[id,ctx.workspaceId,d.supplier_id,title,reference,currency,start,end,claimOn,claimBy,JSON.stringify(scope),JSON.stringify(terms),ctx.actorId]);
  // Terms read from a supplier email are accepted only here, by the owner.
  if(input.offerId&&!prior){const offer=(await c.query("SELECT id,message_id,supplier_id FROM stockchief_runtime.agent_supplier_benefit_offers WHERE workspace_id=$1 AND id=$2 AND status='OPEN' FOR UPDATE",[ctx.workspaceId,String(input.offerId)])).rows[0];
   if(!offer||offer.supplier_id!==d.supplier_id)throw new ValidationError('These emailed terms were already handled or are for another supplier.');
   await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_offers SET status='SAVED',program_id=$3,decided_by=$4,decided_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,offer.id,id,ctx.actorId]);
   await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_programs SET source_message_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,offer.message_id]);}
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Agreed supplier benefit terms recorded',reference:id,after:{title,reference,currency,startsOn:start,endsOn:end,claimOn,claimBy,scope,terms,offerId:input.offerId||null}});return {id};
 },{isolation:'SERIALIZABLE',retrySafe:true}).catch(error=>{if(error.code==='23505'&&error.constraint==='agent_supplier_benefit_reference')throw new ValidationError('This exact supplier agreement and purchase period are already saved. Open the existing agreement.');throw error;});
}
async function facts(db,ctx,id){
 await access(db,ctx,'draft');return factsForDefinition(db,ctx,await get(db,ctx.workspaceId,id));
}
async function estimate(db,ctx,input){
 await access(db,ctx,'suggest');const p={...await definition(db,ctx,input),id:null,revision:0,enabled:false};
 return {...await factsForDefinition(db,ctx,p),estimateOnly:true};
}
async function factsForDefinition(db,ctx,p){
 const clock=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),through=p.ends_on<clock.calendarDate?p.ends_on:clock.calendarDate;
 const rows=(await db.query(`WITH bills AS MATERIALIZED (
  SELECT b.*,j.status AS journal_status,j.posting_date,
   EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=b.workspace_id AND r.reversal_of_entry_id=b.journal_entry_id AND r.status='POSTED') AS reversed
  FROM accounting_supplier_bills b LEFT JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id
  WHERE b.workspace_id=$1 AND b.supplier_id=$2 AND b.issue_date>=$3 AND b.issue_date<=$4 AND b.status<>'VOID'
  ORDER BY b.issue_date,b.id LIMIT 10001
 ), lines AS MATERIALIZED (
  SELECT l.bill_id,count(*)::int AS source_lines,
   count(*) FILTER(WHERE l.sku_id IS NOT NULL AND ($5::boolean OR l.sku_id=ANY($6::text[])))::int AS scoped_lines,
   count(*) FILTER(WHERE l.sku_id IS NOT NULL AND ($5::boolean OR l.sku_id=ANY($6::text[])) AND
    (po.id IS NULL OR po.sku_id<>l.sku_id OR po.purchase_order_id IS DISTINCT FROM b.purchase_order_id OR l.quantity<=0 OR l.line_total_minor<0))::int AS invalid_lines,
   coalesce(sum(l.line_total_minor) FILTER(WHERE l.sku_id IS NOT NULL AND ($5::boolean OR l.sku_id=ANY($6::text[]))),0)::text AS net_minor,
   coalesce(sum(l.quantity) FILTER(WHERE l.sku_id IS NOT NULL AND ($5::boolean OR l.sku_id=ANY($6::text[]))),0)::text AS quantity,
   array_agg(DISTINCT l.sku_id ORDER BY l.sku_id) FILTER(WHERE l.sku_id IS NOT NULL) AS source_skus,
   md5(string_agg(jsonb_build_array(l.id,l.sku_id,l.purchase_order_line_id,l.quantity,l.line_total_minor,po.sku_id,po.purchase_order_id)::text,'|' ORDER BY l.id)) AS line_fingerprint
  FROM bills b JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id
  LEFT JOIN purchase_order_lines po ON po.workspace_id=l.workspace_id AND po.id=l.purchase_order_line_id
  GROUP BY l.bill_id
 ), credits AS (
  SELECT b.id AS supplier_bill_id,count(*)::int AS n,md5(string_agg(jsonb_build_array(c.id,c.amount_minor,c.journal_entry_id,c.credit_date)::text,'|' ORDER BY c.id)) AS fingerprint
  FROM accounting_supplier_credits c
  LEFT JOIN stockchief_runtime.agent_supplier_credit_applications a ON a.workspace_id=c.workspace_id AND a.credit_id=c.id
  JOIN bills b ON b.workspace_id=c.workspace_id AND b.id=coalesce(a.evidence->>'originalBillId',c.supplier_bill_id)
  GROUP BY b.id
 ), returns AS (
  SELECT r.supplier_bill_id,count(*)::int AS n,md5(string_agg(jsonb_build_array(r.id,r.status,r.actual_credit_minor,r.supplier_credit_id)::text,'|' ORDER BY r.id)) AS fingerprint
  FROM supplier_returns r JOIN bills b ON b.workspace_id=r.workspace_id AND b.id=r.supplier_bill_id WHERE r.status<>'CANCELLED' GROUP BY r.supplier_bill_id
 ) SELECT b.id,b.bill_number,b.issue_date::text,b.currency,b.status,b.match_status,b.journal_entry_id,b.journal_status,b.posting_date::text,b.reversed,b.updated_at,b.charges,
  coalesce(l.source_lines,0)::int AS source_lines,coalesce(l.scoped_lines,0)::int AS scoped_lines,coalesce(l.invalid_lines,0)::int AS invalid_lines,
  coalesce(l.net_minor,'0') AS net_minor,coalesce(l.quantity,'0') AS quantity,l.source_skus,l.line_fingerprint,coalesce(c.n,0)::int AS credit_count,c.fingerprint AS credit_fingerprint,
  coalesce(r.n,0)::int AS return_count,r.fingerprint AS return_fingerprint
 FROM bills b LEFT JOIN lines l ON l.bill_id=b.id LEFT JOIN credits c ON c.supplier_bill_id=b.id LEFT JOIN returns r ON r.supplier_bill_id=b.id
 ORDER BY b.issue_date,b.id`,[ctx.workspaceId,p.supplier_id,p.starts_on,through,p.scope.allProducts,p.scope.products.map(product=>product.skuId)])).rows;
 const current=p.scope.products.length?(await db.query(`SELECT s.id AS "skuId",s.code,i.unit_label AS unit,i.quantity_precision::int AS precision FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id`,[ctx.workspaceId,p.scope.products.map(product=>product.skuId)])).rows:[];
 const supplier=(await db.query('SELECT name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.supplier_id])).rows[0];
 const scopeChanged=hash(current)!==hash(p.scope.products)||!supplier||supplier.status!=='active'||supplier.name!==p.scope.supplierName||supplier.email!==p.scope.supplierEmail,holds=[],eligible=[],excluded=[];
 const scopeReview=scopeChanged?{previous:p.scope,current:{...p.scope,supplierName:supplier?.name||'',supplierEmail:supplier?.email||null,products:current},compatible:Boolean(supplier?.status==='active'&&current.length===p.scope.products.length&&current.every(product=>p.scope.products.some(old=>old.skuId===product.skuId&&old.unit===product.unit&&old.precision===product.precision)))}:null;
 if(scopeReview)scopeReview.fingerprint=hash({id:p.id,revision:p.revision,previous:scopeReview.previous,current:scopeReview.current});
 const returnAdjustments=await require('./supplier-benefit-return-adjustments').adjustments(db,ctx,p,rows,clock.calendarDate);
 let net=0n,units=0n;const quantityScaled=value=>{const [a,b='']=String(value).split('.');if(!/^\d+$/.test(a)||!/^\d{0,6}$/.test(b))throw new ValidationError('A supplier quantity needs exact reconciliation before using this agreement.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'));};
 for(const row of rows){
  if(row.currency!==p.currency){excluded.push({...row,review:'Different currency — outside this agreement'});continue;}
  if(!row.scoped_lines){if(['DRAFT','DISPUTED'].includes(row.status))holds.push({...row,review:'An unposted or disputed supplier invoice needs its product evidence reviewed'});else excluded.push({...row,review:'No eligible matched product lines'});continue;}
  const reasons=[];
  if(!['OPEN','PARTIALLY_PAID','PAID'].includes(row.status)||!row.journal_entry_id||row.journal_status!=='POSTED'||row.reversed||row.posting_date>through)reasons.push('No current posted purchase within the reporting date');
  if(!['MATCHED','WITHIN_TOLERANCE'].includes(row.match_status)||row.invalid_lines)reasons.push('Invoice products or quantities are not matched to their purchase order');
  if((row.charges||[]).some(charge=>charge.kind==='discount'||Number(charge.amountMinor)<0))reasons.push('An invoice-level discount needs its eligible product allocation confirmed');
  const adjustment=returnAdjustments.get(row.id);if(adjustment){row.return_adjustment=adjustment;reasons.push(...adjustment.reasons);}
  if(reasons.length){holds.push({...row,review:reasons.join('. ')});continue;}
  const adjustedNet=BigInt(row.net_minor)-BigInt(adjustment?.netMinor||'0'),adjustedUnits=quantityScaled(row.quantity)-BigInt(adjustment?.quantityScaled||'0');
  row.original_net_minor=row.net_minor;row.net_minor=adjustedNet.toString();row.original_quantity=row.quantity;row.quantity=(adjustedUnits/1000000n).toString()+'.'+(adjustedUnits%1000000n).toString().padStart(6,'0');
  net+=adjustedNet;units+=adjustedUnits;eligible.push(row);
 }
 const unitText=(units/1000000n).toString()+'.'+(units%1000000n).toString().padStart(6,'0'),result=calculator.calculate(p.terms,{netMinor:net.toString(),quantity:unitText});
 const claims=p.id?(await db.query('SELECT id,amount_minor::text,external_reference,submitted_on::text,status,acknowledgement_reference,acknowledgement_on::text,withdrawn_reference,withdrawn_on::text,revision,origin,automatic,credited_minor::text,communication_id,problem,source_fingerprint,source_snapshot FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 ORDER BY submitted_on NULLS LAST,created_at,id',[ctx.workspaceId,p.id])).rows:[];
 const submitted=claims.filter(claim=>claim.status!=='WITHDRAWN').reduce((sum,claim)=>sum+BigInt(claim.amount_minor),0n),potential=BigInt(result.potentialBenefitMinor),remaining=potential>submitted?potential-submitted:0n;
 const truncated=rows.length>10000,warnings=[];if(scopeChanged)warnings.push('A selected product code or stock unit changed, or the supplier identity changed. Review the agreement scope.');if(holds.length)warnings.push(holds.length+' invoices have unresolved source facts. The potential below uses checked invoices only.');
 if(truncated)warnings.push('This period has more than 10,000 supplier invoices. Narrow the purchase period and review the supplier agreement before making a claim.');
 if(!p.claim_on||!p.claim_by)warnings.push('Confirm the agreed claim opening date and deadline from the source contract.');if(submitted>potential)warnings.push('Recorded claims exceed the currently calculated benefit. Review the changed purchasing evidence.');
 if(p.claim_by&&clock.calendarDate>p.claim_by&&remaining>0n)warnings.push('The agreed claim deadline has passed. Review the supplier agreement and any actual submission before recording more claim history.');
 const source={programId:p.id,revision:p.revision,terms:p.terms,scope:p.scope,currency:p.currency,startsOn:p.starts_on,endsOn:p.ends_on,claimOn:p.claim_on,claimBy:p.claim_by,asOf:clock.calendarDate,through,scopeChanged,rows,claims};
 return {program:p,today:clock.calendarDate,through,result,eligible,holds,excluded,claims,scopeReview,submittedMinor:submitted.toString(),remainingClaimMinor:remaining.toString(),warnings,
  claimReady:Boolean(p.enabled&&!scopeChanged&&!holds.length&&!truncated&&p.claim_on&&p.claim_by&&clock.calendarDate>=p.claim_on&&clock.calendarDate<=p.claim_by&&remaining>0n),sourceFingerprint:hash(source)};
}
async function recordClaim(db,ctx,id,input){
 return db.transaction(async c=>{
  await lockPlan(c,ctx);const p=await get(c,ctx.workspaceId,id,{lock:true}),prior=(await c.query('SELECT *,submitted_on::text FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND (request_key=$2 OR program_id=$3 AND external_reference=$4) ORDER BY (request_key=$2) DESC LIMIT 1',[ctx.workspaceId,input.requestKey||'',id,String(input.externalReference||'').trim()])).rows[0];
  if(prior){if(prior.program_id!==id||prior.external_reference!==String(input.externalReference||'').trim()||BigInt(prior.amount_minor)!==BigInt(money.userToMinor(input.amount,p.currency,{label:'Submitted claim amount'}))||day(input.submittedOn,'actual submission date')!==String(prior.submitted_on).slice(0,10))throw new ValidationError('This claim reference is already attached to different submitted work.');return {id:prior.id,replayed:true};}
  if(!input.requestKey||String(input.requestKey).length>160||input.confirmed!=='yes')throw new ValidationError('Confirm the exact claim you already submitted outside StockChief. This record does not send a claim or record money received.');
  await c.query("SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_id=$2 AND issue_date>=$3 AND issue_date<=$4 AND status<>'VOID' ORDER BY id FOR SHARE",[ctx.workspaceId,p.supplier_id,p.starts_on,p.ends_on]);
  const f=await facts(c,ctx,id);if(!f.claimReady||input.expectedFingerprint!==f.sourceFingerprint)throw new ValidationError('Review the current matched purchases, claim dates and unresolved facts before recording this submitted claim.');
  const amount=money.userToMinor(input.amount,p.currency,{label:'Submitted claim amount'}),reference=String(input.externalReference||'').trim(),submittedOn=day(input.submittedOn,'actual submission date');
  if(amount<=0||BigInt(amount)>BigInt(f.remainingClaimMinor)||!reference||reference.length>200||submittedOn<f.program.claim_on||submittedOn>f.program.claim_by||submittedOn>f.today)throw new ValidationError('Record the real claim reference, a submission date inside the agreed claim window and an amount within the unclaimed checked benefit.');
  const claimId=newId('supplier-benefit-claim');await c.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_claims(id,workspace_id,program_id,request_key,source_fingerprint,source_snapshot,amount_minor,external_reference,submitted_on,recorded_by)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[claimId,ctx.workspaceId,id,input.requestKey,f.sourceFingerprint,JSON.stringify({program:p,result:f.result,eligible:f.eligible,asOf:f.today}),amount,reference,submittedOn,ctx.actorId]);
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_observations SET needs_review=false,observed_at='epoch' WHERE workspace_id=$1 AND program_id=$2",[ctx.workspaceId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Externally submitted supplier benefit claim recorded',reference:claimId,after:{programId:id,amountMinor:amount,currency:p.currency,externalReference:reference,submittedOn}});return {id:claimId,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true}).catch(error=>{if(error.code==='23505')throw new ValidationError('This submitted claim reference is already recorded. Reload its existing history before recording another claim.');throw error;});
}
async function updateClaim(db,ctx,id,claimId,input){
 return db.transaction(async c=>{
  await lockPlan(c,ctx);await get(c,ctx.workspaceId,id,{lock:true});
  const claim=(await c.query('SELECT *,submitted_on::text,acknowledgement_on::text,withdrawn_on::text FROM stockchief_runtime.agent_supplier_benefit_claims WHERE workspace_id=$1 AND program_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,id,claimId])).rows[0];
  if(!claim)throw new NotFoundError('That claim is not attached to this supplier agreement.');
  const status=input.status,reference=String(input.reference||'').trim(),date=day(input.date,'actual claim update date'),today=await require('../lib/business-time').today(c,ctx.workspaceId);
  if(!['ACKNOWLEDGED','WITHDRAWN'].includes(status)||!reference||reference.length>200||input.confirmed!=='yes'||date<claim.submitted_on||date>today)throw new ValidationError('Confirm the actual external acknowledgement or withdrawal, its reference and its date. This does not record money received.');
  const field=status==='ACKNOWLEDGED'?'acknowledgement':'withdrawn';
  if(claim.status===status&&claim[field+'_reference']===reference&&claim[field+'_on']===date)return {id:claim.id,replayed:true};
  if(claim.revision!==Number(input.revision)||!['SUBMITTED','ACKNOWLEDGED'].includes(claim.status)||status==='ACKNOWLEDGED'&&claim.status!=='SUBMITTED')throw new ValidationError('Reload this claim’s current history before recording another update.');
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_claims SET status=$4,'+field+'_reference=$5,'+field+'_on=$6,revision=revision+1 WHERE workspace_id=$1 AND program_id=$2 AND id=$3',[ctx.workspaceId,id,claimId,status,reference,date]);
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_observations SET needs_review=false,observed_at='epoch' WHERE workspace_id=$1 AND program_id=$2",[ctx.workspaceId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'External supplier benefit claim update recorded',reference:claim.id,before:{status:claim.status},after:{status,reference,date}});
  return {id:claim.id,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
function displayMoney(value,currency){
 const text=String(value);if(!/^-?\d+$/.test(text))throw new ValidationError('Review this supplier amount before displaying it.');
 const signed=BigInt(text),negative=signed<0n,exponent=money.exponent(currency),amount=negative?-signed:signed,factor=10n**BigInt(exponent),fraction=(amount%factor).toString().padStart(exponent,'0');
 return (negative?'-':'')+new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:exponent,maximumFractionDigits:exponent}).formatToParts(amount/factor).map(part=>part.type==='fraction'?fraction:part.value).join('');
}
async function resolveCodes(db,ctx,input){
 const codes=String(input.codes||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);if(!codes.length)return {...input,skuIds:[]};
 if(codes.length>250||new Set(codes).size!==codes.length)throw new ValidationError('Enter up to 250 distinct exact SKU codes, one per line.');
 const rows=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[]) ORDER BY id',[ctx.workspaceId,codes])).rows;
 if(rows.length!==codes.length)throw new ValidationError('Use exact SKU codes from this inventory.');return {...input,skuIds:rows.map(row=>row.id)};
}
function inputMoney(value,currency){const exponent=money.exponent(currency),factor=10n**BigInt(exponent),amount=BigInt(value);return (amount/factor).toString()+(exponent?'.'+(amount%factor).toString().padStart(exponent,'0'):'');}
async function page(db,ctx,{id=null,q='',after='',input={},result=null,evidencePage=1,edit=false,offer=null}={}){
 await owner(db,ctx);const account=await policy.accountState(db,ctx.workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null,locked=!policy.permits(plan,97,'suggest'),canTrack=policy.permits(plan,97,'draft');
 if(id&&!canTrack)policy.requireJob(plan,97,'draft');const selectedResult=id?await facts(db,ctx,id):result,editing=Boolean(id&&edit&&canTrack),claimsService=require('./agent-supplier-benefit-claims');
 // Terms read from a supplier email fill the form; the owner checks and accepts them.
 const emailed=!locked&&(offer||input.offerId)?await claimsService.offer(db,ctx,String(offer||input.offerId)):null;
 if(emailed&&emailed.status==='OPEN'&&!Object.keys(input).filter(key=>key!=='offerId').length)input=claimsService.offerInput(emailed);
 const offers=locked?[]:(await db.query("SELECT o.id,o.created_at,s.name FROM stockchief_runtime.agent_supplier_benefit_offers o JOIN suppliers s ON s.workspace_id=o.workspace_id AND s.id=o.supplier_id WHERE o.workspace_id=$1 AND o.status='OPEN' ORDER BY o.created_at,o.id LIMIT 20",[ctx.workspaceId])).rows;
 let claimView=null;
 if(id&&canTrack&&selectedResult){const p=selectedResult.program;
  claimView={mailboxes:(await db.query("SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL AND provider_type IN ('gmail','microsoft365') ORDER BY display_name,id LIMIT 50",[ctx.workspaceId])).rows,
   nearTier:nearTier(p,selectedResult),periodClosed:selectedResult.today>p.ends_on,claimLimit:p.claim_limit_minor?inputMoney(p.claim_limit_minor,p.currency):'',
   canPrepare:Boolean(p.enabled&&p.connector_id&&selectedResult.claimReady&&selectedResult.today>p.ends_on&&!selectedResult.claims.some(c=>['PREPARED','SENDING'].includes(c.status))),
   credits:Object.fromEntries(await Promise.all(selectedResult.claims.filter(c=>c.origin==='prepared'||['SUBMITTED','ACKNOWLEDGED','CREDITED'].includes(c.status)).map(async c=>[c.id,await claimsService.credits(db,ctx,p,{...c,amount_minor:c.amount_minor})])))};
 }
 if(editing){const p=selectedResult.program;if(selectedResult.claims.length)throw new ValidationError('Claim history preserves these original terms. Record revised agreed terms as a separate agreement.');
  input={supplierId:p.supplier_id,title:p.title,sourceReference:p.source_reference,currency:p.currency,startsOn:p.starts_on,endsOn:p.ends_on,claimOn:p.claim_on,claimBy:p.claim_by,allProducts:p.scope.allProducts?'yes':'no',codes:p.scope.products.map(product=>product.code).join('\n'),...p.terms,tiersText:p.terms.tiers.map(tier=>(p.terms.basis==='net_spend'?inputMoney(tier.threshold,p.currency):tier.threshold)+' | '+(p.terms.benefit==='percentage'?tier.rateBasisPoints/100:inputMoney(tier.unitPriceMinor,p.currency))).join('\n')};
 }
 const query=String(q).trim().slice(0,120),suppliers=locked?[]:(await db.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' AND ($2='' OR name ILIKE '%'||$2||'%' OR id=$3) ORDER BY (id=$3) DESC,name,id LIMIT 51",[ctx.workspaceId,query,input.supplierId||''])).rows;
 const programmes=(await db.query(`SELECT p.id,p.title,p.enabled,p.revision,p.starts_on::text,p.ends_on::text,s.name AS supplier_name FROM stockchief_runtime.agent_supplier_benefit_programs p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.id>$2 ORDER BY p.id LIMIT 51`,[ctx.workspaceId,String(after).slice(0,160)])).rows;
 const pageNumber=Number(evidencePage);if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>1000)throw new ValidationError('Choose a valid purchase evidence page.');
 const sources=selectedResult&&!selectedResult.estimateOnly?selectedResult.eligible.concat(selectedResult.holds,selectedResult.excluded):[];
 return {locked,canTrack,editing,shadow:account.shadow,selected:id,result:selectedResult,input,q:query,emailed,offers,claimView,suppliers:suppliers.slice(0,50),moreSuppliers:suppliers.length>50,programmes:programmes.slice(0,50),moreProgrammes:programmes.length>50,requestKey:newId('benefit-claim'),displayMoney,sourceRows:sources.slice((pageNumber-1)*100,pageNumber*100),sourcePage:pageNumber,moreSources:sources.length>pageNumber*100,sourceTotal:sources.length};
}
async function refreshScope(db,ctx,id,input){
 return db.transaction(async c=>{
  await lockPlan(c,ctx);const p=await get(c,ctx.workspaceId,id,{lock:true}),f=await facts(c,ctx,id),review=f.scopeReview;
  if(!review?.compatible||review.fingerprint!==input.expectedFingerprint||input.confirmed!=='yes'||p.revision!==Number(input.revision))throw new ValidationError('Review the current supplier identity, product codes and unchanged stock units before confirming this factual scope. Changed stock units need separate contract review.');
  await products(c,ctx.workspaceId,p.supplier_id,p.scope.products.map(product=>product.skuId));
  await c.query('UPDATE stockchief_runtime.agent_supplier_benefit_programs SET scope=$3::jsonb,authorized_by=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,JSON.stringify(review.current),ctx.actorId]);
  await c.query("UPDATE stockchief_runtime.agent_supplier_benefit_observations SET needs_review=false,observed_at='epoch' WHERE workspace_id=$1 AND program_id=$2",[ctx.workspaceId,id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Supplier benefit factual scope reviewed',reference:id,before:review.previous,after:review.current});return {id};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Close to the next tier while the purchase period is still open.
function nearTier(p,f){
 if(f.today>p.ends_on||f.result.nextThreshold===null||f.result.remainingToNext===null)return null;
 const percent=BigInt(p.alert_percent||10),scaled=v=>{const [a,b='']=String(v).split('.');return BigInt(a)*1000000n+BigInt(b.padEnd(6,'0').slice(0,6));};
 const next=scaled(f.result.nextThreshold),left=scaled(f.result.remainingToNext);
 if(left<=0n||left*100n>next*percent)return null;
 const tier=p.terms.tiers[(f.result.tierIndex??-1)+1],unit=p.scope.products[0]?.unit||'units';
 const show=v=>p.terms.basis==='net_spend'?displayMoney(v,p.currency):v+' '+unit;
 return {nextThreshold:f.result.nextThreshold,remainingToNext:f.result.remainingToNext,text:'Another '+show(f.result.remainingToNext)+' of purchases by '+p.ends_on+' reaches the next tier ('+(tier?.rateBasisPoints!==undefined?tier.rateBasisPoints/100+'%':'better price')+' from '+show(f.result.nextThreshold)+').'};
}
async function observe(c,ctx,p){
 const f=await factsForDefinition(c,ctx,p),near=nearTier(p,f),earned=f.today>p.ends_on?f.result.potentialBenefitMinor:null;
 const summary={title:p.title,supplier:p.scope.supplierName,currency:p.currency,potentialBenefitMinor:f.result.potentialBenefitMinor,remainingClaimMinor:f.remainingClaimMinor,claimReady:f.claimReady,claimOn:p.claim_on,claimBy:p.claim_by,warnings:f.warnings,nearTier:near,earnedMinor:earned};
 await c.query(`INSERT INTO stockchief_runtime.agent_supplier_benefit_observations(program_id,workspace_id,source_fingerprint,program_revision,result,needs_review) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(program_id) DO UPDATE SET source_fingerprint=EXCLUDED.source_fingerprint,program_revision=EXCLUDED.program_revision,result=EXCLUDED.result,needs_review=EXCLUDED.needs_review,observed_at=now()`,[p.id,ctx.workspaceId,f.sourceFingerprint,p.revision,JSON.stringify(summary),f.claimReady||f.warnings.length>0||Boolean(near)]);return summary;
}
// Pro and Custom: tracks each agreement, follows claims to credit notes and
// claims a finished period. Watch only, pause and the first 14 days stop it;
// Ask me first prepares claims for approval without sending them.
async function run(db,workspaceId){
 const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,97,'automatic')||account.shadow)return {skipped:'plan_or_watch_period'};
 const modes=require('../autopilot/job-modes'),permission=await require('../autopilot/postgres-service').getState(db,workspaceId),watch=await modes.restriction(db,workspaceId,97,false);
 if(!permission.canAutomate||watch)return {skipped:'owner_authority'};
 const rows=(await db.query(`SELECT p.id,p.authorized_by FROM stockchief_runtime.agent_supplier_benefit_programs p LEFT JOIN stockchief_runtime.agent_supplier_benefit_observations o ON o.workspace_id=p.workspace_id AND o.program_id=p.id
  WHERE p.workspace_id=$1 AND p.enabled AND (o.program_id IS NULL OR o.observed_at<now()-interval '1 hour' OR o.program_revision<>p.revision
   OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_benefit_claims c WHERE c.workspace_id=p.workspace_id AND c.program_id=p.id AND c.status='SENDING')) ORDER BY o.observed_at NULLS FIRST,p.id LIMIT 5`,[workspaceId])).rows;
 let checked=0,held=0,claimed=0;for(const row of rows){try{const changed=await db.transaction(async c=>{
  const ctx={workspaceId,actorId:row.authorized_by};await lockPlan(c,ctx);const current=await policy.accountState(c,workspaceId),state=await require('../autopilot/postgres-service').getState(c,workspaceId),stop=await modes.restriction(c,workspaceId,97,false),ask=Boolean(await modes.restriction(c,workspaceId,97,true));
  if(current.shadow||!policy.permits(current.plan,97,'automatic')||!state.canAutomate||stop)return;
  const p=await get(c,workspaceId,row.id,{lock:true});if(!p.enabled)return false;
  await c.query('SAVEPOINT supplier_benefit_cycle');
  try{const r=await require('./agent-supplier-benefit-claims').cycle(c,ctx,p,{ask});if(r.prepared)claimed++;await c.query('RELEASE SAVEPOINT supplier_benefit_cycle');}
  catch(error){await c.query('ROLLBACK TO SAVEPOINT supplier_benefit_cycle');await c.query('RELEASE SAVEPOINT supplier_benefit_cycle');if(![400,402,403,404,422].includes(error.status))throw error;}
  await observe(c,ctx,p);return true;
 },{isolation:'SERIALIZABLE',retrySafe:true});if(changed)checked++;}catch(error){if(!['validation_error','authorization_error','entitlement_required','agent_plan_required'].includes(error.code))throw error;held++;}}
 return {checked,held,claimed};
}
async function inbox(db,workspaceId,actorId){
 const account=await policy.accountState(db,workspaceId);if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,97,'suggest'))return [];
 try{await owner(db,{workspaceId,actorId});}catch(error){if(error.status===403)return [];throw error;}
 const canTrack=policy.permits(account.plan,97,'draft'),claims=await require('./agent-supplier-benefit-claims').inbox(db,workspaceId,{canTrack});if(!canTrack)return claims;
 const rows=(await db.query(`SELECT o.program_id,o.result,o.observed_at FROM stockchief_runtime.agent_supplier_benefit_observations o JOIN stockchief_runtime.agent_supplier_benefit_programs p ON p.workspace_id=o.workspace_id AND p.id=o.program_id WHERE o.workspace_id=$1 AND p.enabled AND o.needs_review ORDER BY o.observed_at,o.program_id LIMIT 51`,[workspaceId])).rows;
 return rows.slice(0,50).map(row=>({kind:'accounting',importance:'Needs You',priority:72,title:(row.result.nearTier&&!row.result.claimReady&&!row.result.warnings.length?'Close to the next rebate tier: ':'Review supplier benefit: ')+row.result.title,happened:'StockChief checked the agreed purchasing terms and matched supplier invoices.',
  why:[row.result.nearTier?.text,...row.result.warnings].filter(Boolean).join(' ')||'A potential claim needs your review against the supplier agreement.',recommendation:'Review current purchases and claim dates. This check does not post money.',href:'/autopilot/supplier-benefits/'+row.program_id,actionLabel:'Review supplier benefit',sourceId:'supplier-benefit:'+row.program_id,createdAt:row.observed_at,at:row.observed_at})).concat(claims);
}
module.exports={owner,access,get,configure,products,day,facts,factsForDefinition,lockPlan,nearTier,recordClaim,updateClaim,estimate,formTerms,page,resolveCodes,displayMoney,run,inbox,refreshScope,
 reviewDefinition:{id:97,key:'supplier-benefits',label:'Track agreed supplier rebates and volume discounts',readPage:async()=>({summary:'Growth gives a one-time estimate from rebate terms you enter or that a supplier emailed. Pro and Custom track agreements against matched purchases, warn when you are close to the next tier, work out the rebate earned when the period ends, send the claim to the supplier within your claim limit and follow it to the supplier credit note. Accepting supplier terms always needs you.',rows:[{Suggestion:'Check the supplier agreement against matched purchase invoices',Action:'Open supplier benefits',link:'/autopilot/supplier-benefits'}],more:false})}};
