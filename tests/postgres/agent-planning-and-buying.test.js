'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews');
const commerce=require('../../src/operations/postgres-commerce');

test('sales scenarios, partial supplier deliveries and competing quotations use stored inventory records and the current plan', {timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:12}),{db,ctx,workflows}=f;
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const plan=async tier=>db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,
    (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE') ON CONFLICT(account_id) DO UPDATE SET
    plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),f.owner.accountId,tier]);
  const review=async(key,more={})=>reviews.run(db,ctx,key,{filter:code,...more});
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const ago=require('../../src/accounting/customer-money').addDays;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=require('supertest').agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(login.text)[1],email:f.email,password:f.password});
  await plan('enterprise');
  const annex=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'});
  const inv=require('../../src/domain/postgres-inventory-engine');
  await inv.transfer(db,ctx,{skuId:sku,sourceLocationId:f.location.id,destinationLocationId:annex.id,quantity:3,idempotencyKey:randomUUID()});
  const stock=(await review('stock-by-location')).rows;
  assert.deepEqual(stock.map(r=>[r.Location,Number(r.Units)]),[['Annex',3],['Dispatch',9]]);
  for(const count of [8,7])await inv.adjust(db,ctx,{skuId:sku,locationId:f.location.id,countedQuantity:count,reasonCode:'cycle_count',
    occurredAt:ago(today,-10)+'T16:00:00Z',idempotencyKey:randomUUID()});
  const loss=(await review('repeat-loss')).rows;
  assert.equal(loss.length,1);assert.equal(loss[0].Warehouse,'Dispatch');assert.equal(Number(loss[0]['Units removed']),2);
  assert.equal((await review('count-priorities')).rows[0].Shelf,'Dispatch');
  const parcels=[];
  for(const quantity of [1,2]){
    const parcel=await f.parcel({quantity});
    await f.shipping.markPacked(db,ctx,parcel.shipmentId);
    await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TEST-'+quantity});
    parcels.push(parcel.shipmentId);
  }
  const supplier=await commerce.createSupplier(db,ctx,{name:'Alternative',email:'alternative@example.test',currency:'USD'});
  await db.query("UPDATE suppliers SET email='original@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const mail=require('../../src/connections/postgres-mail'),evidence=require('../../src/purchasing/postgres-supplier-evidence');
  const mailbox=randomUUID();
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at) VALUES($1,$2,$1,'Quote mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)",[mailbox,ctx.workspaceId]);
  for(const [supplierId,sender,minor] of [['fixture-supplier','original@example.test',150],[supplier.id,'alternative@example.test',125]]){
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId,destinationLocationId:f.location.id,currency:'USD',orderDate:ago(today,-10),
      expectedDate:ago(today,-2),idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:4,unitCost:minor/100}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    const order=(await db.query('SELECT * FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0];
    const body='Quotation for '+order.po_number+': 4 units of '+code+' at USD '+(minor/100).toFixed(2)+' per unit.';
    const source=await mail.capture(db,{id:mailbox,workspace_id:ctx.workspaceId,provider_type:'gmail'},{messageId:randomUUID(),sender,subject:'Quotation '+order.po_number,bodyText:body});
    const prepared=await evidence.assess(db,ctx,order,{documentType:'quotation',sourceMessageId:source.messageId,evidenceQuote:body,
      documentReference:'Q-'+minor,currency:'USD',lines:[{sku:code,quantity:4,quantityBasis:'stock',unitCostMinor:minor}]});
    await db.transaction(c=>evidence.execute(c,ctx,prepared.payload));
    if(supplierId===supplier.id){
      await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:1,locationId:f.location.id}]});
      const late=(await review('overdue-incoming')).rows.find(r=>r.Order===order.po_number);
      assert.equal(Number(late['Still due']),3);
      const received=(await review('delivery-check')).rows.find(r=>r.Order===order.po_number);
      assert.equal(Number(received.Received),1);assert.equal(Number(received['Still due']),3);
    }
  }
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,20,30,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,f.location.id]);
  await db.query("UPDATE sales_orders SET needed_by=$3 WHERE workspace_id=$1 AND id IN (SELECT sales_order_id FROM sales_shipments WHERE id=ANY($2))",[ctx.workspaceId,parcels,ago(today,-1)]);
  await f.shipping.applyTracking(db,ctx,parcels[0],{status:'DELIVERED',externalEventId:'service-level-first',occurredAt:ago(today,-1)+'T12:00:00Z'});
  for(const [id,prediction,comparable] of [['closed',10,1],['stockout',90,0]]){
    await db.query(`INSERT INTO demand_forecasts(id,workspace_id,sku_id,as_of,horizon_days,horizon_end,horizon_units,confidence,model_version,created_at)
      VALUES($1,$2,$3,$4,7,$5,$6,'moderate','fixture',$4)`,[id,ctx.workspaceId,sku,ago(today,-9),ago(today,-2),prediction]);
    await db.query(`INSERT INTO forecast_outcomes(id,workspace_id,forecast_id,sku_id,scored_at,predicted_units,actual_units,error_units,absolute_error,comparable,created_at)
      VALUES($1,$2,$1,$3,$4,$5,8,$6,$6,$7,$4)`,[id,ctx.workspaceId,sku,ago(today,-1)+'T12:00:00Z',prediction,prediction-8,comparable]);
  }
  for(const tier of ['starter','growth','pro','enterprise']){
    await plan(tier);
    const row=(await review('reorder-explanation')).rows.find(r=>r.Warehouse==='Dispatch');
    assert.equal(row.Available,5);assert.equal(row.Incoming,7);assert.equal(row['Units to order'],18);
    if(tier==='starter')await browser.get('/autopilot/reviews/service-levels').expect(402);
    else{
      const service=await review('service-levels',{filter:'',scheduled:true}),customer=service.rows.find(r=>r['Party type']==='Customer'),vendor=service.rows.find(r=>r.Name==='Alternative');
      assert.match(service.summary,/1 comparable SKU forecast,.*2\.00 units/);
      assert.equal(customer['Due orders'],2);assert.equal(Number(customer['Fill rate %']),100);assert.equal(Number(customer['OTIF %']),50);
      assert.equal(Number(vendor['Fill rate %']),25);assert.equal(Number(vendor['OTIF %']),0);
    }
    if(tier==='starter'){
      await browser.get('/autopilot/reviews/demand-scenario').query({change:20}).expect(402);
      assert.doesNotMatch((await browser.get('/autopilot/reviews').expect(200)).text,/href="\/autopilot\/reviews\/demand-scenario"/);
      for(const key of ['compare-quotes','repeat-loss','demand-scenario'])await assert.rejects(review(key,{change:20}),e=>e.code==='entitlement_required');
      assert.match((await review('overdue-incoming')).rows[0].Suggestion,/overdue/);continue;
    }
    const quotes=(await review('compare-quotes')).rows;
    assert.deepEqual(quotes.map(r=>[r.Supplier,r['Supplier unit price']]),[['Alternative','$1.25'],['Fixture parts','$1.50']]);
    const page=await browser.get('/autopilot/reviews/demand-scenario').query({filter:code,change:20}).expect(200);
    assert.match(page.text,/Scenario 30-day sales/);assert.match(page.text,/1\.2<\/td>/);
    const asked=await require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').prepare(null,db,ctx,'What happens if sales grow 20%?',{agentJob:'demand-scenario',search:code,demandChangePercent:20});
    assert.equal(asked.rows.find(r=>r.Warehouse==='Dispatch')['Scenario 30-day sales'],1.2);
    assert.ok(asked.sources[0].href.includes('change=20'));
    const scenario=(await review('demand-scenario',{change:20})).rows.find(r=>r.Warehouse==='Dispatch');
    assert.equal(scenario['Baseline 30-day sales'],1);assert.equal(scenario['Scenario 30-day sales'],1.2);
    assert.equal((await review('demand-scenario',{change:-100})).rows[0]['Scenario 30-day sales'],0);
  }
  await assert.rejects(review('demand-scenario',{change:'anything'}),/between/);
  assert.equal((await review('customer-check-in',{filter:''})).rows.length,0);
  await db.query("UPDATE sales_shipments SET shipped_at=(now()-interval '100 days')::text WHERE workspace_id=$1 AND id=ANY($2)",[ctx.workspaceId,parcels]);
  assert.match((await review('customer-check-in',{filter:'Receiver'})).rows[0].Draft,/Hello Receiver/);
  await plan('growth');await assert.rejects(review('customer-check-in',{filter:'Receiver'}),e=>e.code==='entitlement_required');
  const end=ago(today.slice(0,7)+'-01',-1),start=end.slice(0,7)+'-01',prior=ago(start,-1);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ctx.workspaceId,ago(prior.slice(0,7)+'-01',-1)]);
  const ledger=require('../../src/accounting/postgres-ledger');
  for(const [date,price,cost] of [[prior,2000,600],[end,2200,900]]){
    await ledger.post(db,ctx,{postingDate:date,sourceKey:'sale-'+date,description:'Fixture monthly sale',lines:[
      {accountKey:'CASH',debitMinor:price},{accountKey:'SALES_REVENUE',creditMinor:price},
      {accountKey:'COST_OF_GOODS_SOLD',debitMinor:cost},{accountKey:'INVENTORY_ASSET',creditMinor:cost}]});
  }
  await ledger.post(db,ctx,{postingDate:prior,sourceKey:'historical-stock',description:'Historical purchase for report',lines:[
    {accountKey:'INVENTORY_ASSET',debitMinor:3000},{accountKey:'CASH',creditMinor:3000}]});
  const counts=require('../../src/operations/postgres-count-reviews');
  const physical=Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND location_id=$2 AND sku_id=$3',[ctx.workspaceId,f.location.id,sku])).rows[0].on_hand);
  const count=await counts.prepare(db,ctx,{locationId:f.location.id,reference:'Year close count',lines:[{skuId:sku,quantity:physical}]});
  await counts.approve(db,ctx,count.id,(await counts.get(db,ctx,count.id)).integrity_hash);
  await db.query("UPDATE physical_count_reviews SET approved_at=($2::date+time '12:00') AT TIME ZONE 'UTC' WHERE id=$1",[count.id,end]);
  await counts.prepare(db,ctx,{locationId:f.location.id,reference:'Pending count',lines:[{skuId:sku,quantity:physical}]});
  const download=(job)=>browser.get('/autopilot/reviews/'+job+'/download').query({filter:end.slice(0,7)});
  const binary=(req)=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  for(const tier of ['starter','growth','pro','enterprise']){
    await plan(tier);
    if(tier!=='enterprise'){
      await download('board-pack').expect(402);
      await browser.get('/autopilot/reviews/board-pack').expect(402);
    }else{
      const preview=await browser.get('/autopilot/reviews/board-pack').query({filter:end.slice(0,7)}).expect(200);
      assert.match(preview.text,/Download board pack with charts/);
      const pdf=await binary(download('board-pack')).expect(200).expect('Content-Type',/application\/pdf/);
      const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(pdf.body)}),document=await loading.promise;
      const first=await document.getPage(1),text=(await first.getTextContent()).items.map(i=>i.str).join(' ');
      for(const figure of ['$22.00','$9.00','$13.00'])assert.ok(text.includes(figure),figure);
      assert.ok((await first.getOperatorList()).fnArray.includes(pdfjs.OPS.constructPath),'PDF contains chart geometry');
      assert.equal(document.numPages,1);await loading.destroy();
    }
    if(tier==='starter')await download('year-end-stocktake').expect(402);
    else{
      const pack=await binary(download('year-end-stocktake')).expect(200);
      const xlsx=require('xlsx'),workbook=xlsx.read(pack.body,{type:'buffer'});
      assert.equal(xlsx.utils.sheet_to_json(workbook.Sheets['Closing valuation']).find(r=>r.SKU==='Unassigned ledger entries')['Closing value'],15);
      const lines=xlsx.utils.sheet_to_json(workbook.Sheets['Approved count lines']);
      assert.equal(lines.length,1);assert.equal(lines[0].SKU,code);assert.equal(lines[0].Reference,'Year close count');assert.equal(lines[0].Counted,physical);
    }
    if(tier==='starter'){
      for(const key of ['month-end-stock','margin-change'])await assert.rejects(review(key,{filter:end.slice(0,7)}),e=>e.code==='entitlement_required');continue;
    }
    const close=(await review('month-end-stock',{filter:end.slice(0,7)})).rows[0];
    assert.equal(close['Stock on books at month end'],'$15.00');assert.equal(close['Cost of goods sold'],'$9.00');
    const change=(await review('margin-change',{filter:end.slice(0,7)})).rows[0];
    assert.equal(change['Gross profit'],'$13.00');assert.equal(change['Revenue change'],'$2.00');assert.equal(change['Cost of goods change'],'$3.00');
    assert.equal(change['Gross profit change'],'-$1.00');
    await browser.get(change.link).expect(200);
  }
  await assert.rejects(review('month-end-stock',{filter:today.slice(0,7)}),/completed calendar month/);
  const priorQuarter=(await require('../../src/purchasing/agent-supplier-pack').report(db,ctx,{today,filter:''})).span;
  await db.query("UPDATE purchase_orders SET ordered_at=$2 WHERE workspace_id=$1 AND status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')",[ctx.workspaceId,priorQuarter.end+'T10:00:00Z']);
  const forSupplier=()=>review('quarterly-supplier-pack',{filter:'Alternative'});
  assert.equal(Number((await forSupplier()).rows[0]['Received by close']),0,'later receipts stay in their actual quarter');
  await db.query("UPDATE purchase_order_receipts r SET received_at=$3 FROM purchase_orders p WHERE r.workspace_id=$1 AND p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id AND p.supplier_id=$2",[ctx.workspaceId,supplier.id,priorQuarter.end+'T11:00:00Z']);
  for(const tier of ['starter','growth','pro','enterprise']){
    await plan(tier);
    const downloadPack=()=>browser.get('/autopilot/reviews/quarterly-supplier-pack/download').query({filter:supplier.id});
    if(tier==='starter'||tier==='growth'){await downloadPack().expect(402);continue;}
    const line=(await forSupplier()).rows[0];assert.equal(Number(line.Ordered),4);assert.equal(Number(line['Received by close']),1);
    const packed=await binary(downloadPack()).expect(200);
    const library=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=library.getDocument({data:new Uint8Array(packed.body)});
    const doc=await loading.promise,content=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
    assert.ok(content.includes(line.Order));assert.ok(content.includes('Alternative'));assert.ok(content.includes('$1.25'));
    assert.doesNotMatch(content,/Fixture parts/);await loading.destroy();
    await browser.get('/autopilot/reviews/quarterly-supplier-pack/download').expect(400);
  }
});
