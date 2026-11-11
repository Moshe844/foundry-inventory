
'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/supplier-invoice-intake-fixture');
const returns=require('../../src/purchasing/agent-supplier-returns');
const native=require('../../src/operations/postgres-returns');
const credits=require('../../src/purchasing/agent-supplier-credit-notes');
const catalog=require('../../src/domain/postgres-catalog-service');
const quality=require('../../src/operations/agent-quality-holds');
const money=require('../../src/domain/currency');

test('receipt-backed supplier returns require physical handoff and retain exact outstanding credits',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx,browser,workflows,location,today}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0];
  const route=returns.href;
  let number=0;
  async function bill(lines,{receipt}={}){
    const p=await f.po(lines,!receipt);
    const received=receipt?await workflows.receivePurchaseOrder(db,ctx,p.purchaseOrderId,{
      idempotencyKey:randomUUID(),qcConfirmed:'yes',lines:p.lineIds.map((lineId,i)=>({lineId,locationId:location.id,
        quantity:lines[i].quantityUnits,secondaryQuantity:lines[i].secondaryQuantity,...lines[i].receipt}))}):null;
    const invoice='RTV-INVOICE-'+(++number);
    const amounts=lines.map(l=>Math.round(Number(l.secondaryQuantity??l.quantityUnits)*Number(l.unitCost)*100));
    const booked=await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:p.purchaseOrderId,
      supplierInvoiceNumber:invoice,issueDate:today,dueDate:f.due,currency:'USD',taxMinor:0,
      documentTotalMinor:amounts.reduce((a,b)=>a+b,0),idempotencyKey:randomUUID(),
      lines:p.lineIds.map((purchaseOrderLineId,i)=>({purchaseOrderLineId,skuId:lines[i].skuId,description:'Original purchase',
        quantity:lines[i].quantityUnits,secondaryQuantity:lines[i].secondaryQuantity,unitCostMinor:Math.round(Number(lines[i].unitCost)*100)}))});
    assert.equal(booked.status,'OPEN',JSON.stringify(booked));
    const receiptLines=(await db.query(`SELECT l.id,l.sku_id FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
      WHERE r.workspace_id=$1 AND r.purchase_order_id=$2`,[ws,p.purchaseOrderId])).rows;
    return {billId:booked.billId,invoice,receiptLines,qualityId:received?.qualityHoldIds?.[0]};
  }
  const one=async(qty=4)=>bill([{skuId:sku,quantityUnits:qty,unitCost:1}]);
  const args=(b,reference,lines=[{receiptLineId:b.receiptLines[0].id,quantity:1}],expected='1.00')=>({
    billId:b.billId,requestKey:randomUUID(),supplierReference:reference,reason:'Confirmed physical damage',
    supplierApproved:'yes',physicallyChecked:'yes',expected,lines});
  const read=id=>returns.get(db,ctx,id);
  const approve=async id=>returns.approve(db,ctx,id,{confirmed:'yes',expectedHash:(await read(id)).evidence_hash});
  const dispatch=async id=>returns.dispatch(db,ctx,id,{confirmed:'yes',expectedHash:(await read(id)).evidence_hash,
    shippedOn:today,dispatchReference:'HANDOFF-'+id});
  const authorize=async(id,revision=0)=>returns.configure(db,ctx,id,{revision,locationId:location.id,maximum:'10.00',confirmed:'yes'});
  const work=()=>f.queue.processOne(db,f.handlers,{owner:'tracked-supplier-return-test',kinds:[returns.KIND]});
  const balance=async id=>Number((await db.query('SELECT balance_minor FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0].balance_minor);
  const stock=async skuId=>{
    const r=(await db.query('SELECT on_hand,secondary_on_hand,quality_held FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ws,skuId,location.id])).rows[0];
    return [Number(r.on_hand),r.secondary_on_hand==null?null:Number(r.secondary_on_hand),Number(r.quality_held)];
  };
  const note=async(b,ref,creditNumber,amount)=>{
    const original=['Supplier credit note','Credit note number: '+creditNumber,'Original invoice number: '+b.invoice,
      'Supplier return number: '+ref,'Credit note date: '+today,'Currency: USD','Tax: 0.00','Total: '+money.fromMinor(amount,'USD')].join('\n');
    const source=await f.arrive(original,{filename:'physical-return-credit.txt'});
    await f.runSource();
    const id=await f.intake(source.attachmentId);
    assert.equal((await f.service.get(db,ctx,id)).status,'CREDIT_REVIEW');
    return id;
  };
  const preview=async(id,r)=>(await credits.page(db,ctx,{id,managedReturnId:r})).selected;
  const apply=(id,r,p)=>credits.approve(db,ctx,id,{confirmed:'yes',fingerprint:p.facts.fingerprint,managedReturnId:r,
    confirmVariance:'yes',reason:'Reviewed original supplier return and supplier-issued amount'});
  const created=await one();

  await t.test('Starter and Growth are excluded from managed return intake and reports',async()=>{
    for(const tier of ['starter','growth']){
      await f.subscribe(tier);
      await assert.rejects(returns.capture(db,ctx,args(created,'EXCLUDED-'+tier)),e=>e.code==='entitlement_required');
      const locked=await browser.get(route).expect(200);
      assert.doesNotMatch(locked.text,/Save receipt and authorization/);
      assert.match(locked.text,/Pro/);
      assert.equal((await returns.schedule(db,ws)).queued,0);
    }
  });

  let sample,returnId;
  await t.test('Pro completes a physically checked receipt and exact individual return before teaching',async()=>{
    await f.subscribe('pro');
    const before=await stock(sku);
    const page=await browser.get(route).query({billId:created.billId}).expect(200);
    assert.match(page.text,/Supplier authorization or RMA reference/);
    const {id,queued}=await returns.capture(db,ctx,args(created,'RMA-PRO-EXAMPLE'));
    sample=id;
    assert.equal(queued,false);
    assert.equal((await stock(sku))[0],before[0]);
    assert.equal((await stock(sku))[2],before[2]+1);
    await assert.rejects(authorize(id),/Complete an individually approved/);
    const approved=await approve(id);
    returnId=approved.returnId;
    assert.equal((await native.getSupplierReturn(db,ws,returnId)).status,'AUTHORIZED');
    assert.equal((await approve(id)).replayed,true);
    await assert.rejects(native.shipSupplierReturn(db,ctx,returnId,{idempotencyKey:randomUUID()}),/tracked supplier return/);
    await assert.rejects(returns.dispatch(db,ctx,id,{confirmed:'no',expectedHash:(await read(id)).evidence_hash,shippedOn:today,dispatchReference:'unsent'}),/actual handoff/);
    await dispatch(id);
    assert.equal((await dispatch(id)).replayed,true);
    assert.deepEqual(await stock(sku),[before[0]-1,before[1],before[2]]);
    assert.equal(await balance(created.billId),400);
    assert.equal((await native.getSupplierReturn(db,ws,returnId)).status,'AWAITING_CREDIT');
    await assert.rejects(native.reconcileSupplierReturn(db,ctx,returnId,{amountMinor:100,creditNumber:'UNSOURCED',idempotencyKey:randomUUID()}),/original supplier credit note/);
  });

  await t.test('wrong and excessive notes hold, and two actual partial notes clear one expected credit',async()=>{
    const wrong=await note(created,'OTHER-RETURN','CM-WRONG',100);
    assert.equal((await preview(wrong,returnId)).facts.status,'WAITING');
    const excessive=await note(created,'RMA-PRO-EXAMPLE','CM-EXCESS',110);
    assert.match((await preview(excessive,returnId)).facts.problem,/exceeds the outstanding/);
    const part=await note(created,'RMA-PRO-EXAMPLE','CM-PARTIAL',40);
    const p=await preview(part,returnId);
    assert.equal(p.facts.candidate.amount,40);
    assert.equal(p.facts.candidate.remainingReturnCredit,60);
    const cost=(await read(sample)).dispatch.lines[0].costMinor;
    assert.equal(p.facts.candidate.returnCostMinor,Math.round(cost*0.4));
    const results=await Promise.all([apply(part,returnId,p),apply(part,returnId,p)]);
    assert.equal(results.filter(x=>x.replayed).length,1);
    assert.equal(await balance(created.billId),360);
    const pending=await returns.credited(db,ctx,await read(sample));
    assert.equal(pending.status,'AWAITING_CREDIT');
    assert.equal(pending.remaining,60);
    await browser.get(route+'/'+sample).expect(200).expect(/Still owed/).expect(/CM-PARTIAL/);
    const other=await note(created,'RMA-PRO-EXAMPLE','CM-SECOND',60);
    const p2=await preview(other,returnId);
    assert.equal(p2.facts.candidate.remainingReturnCredit,0);
    const booked=await apply(other,returnId,p2);
    assert.equal(await balance(created.billId),300);
    const done=await returns.credited(db,ctx,await read(sample));
    assert.equal(done.status,'RECONCILED');
    assert.equal(done.remaining,0);
    assert.equal(done.cost,cost);
    assert.equal(done.rows.length,2);
    assert(booked.journalEntryId);
    await authorize(sample);
  });

  await t.test('the Pro worker holds after downgrade and then prepares a taught return from exact evidence',async()=>{
    const pending=await one();
    const result=await returns.capture(db,ctx,args(pending,'RMA-TRAINED'));
    assert.equal(result.queued,true);
    await f.subscribe('growth');
    assert.equal((await work()).result.state,'HELD');
    assert.equal((await read(result.id)).return_id,null);
    await f.subscribe('pro');
    await authorize(sample,1);
    assert.equal((await returns.schedule(db,ws)).queued,1);
    const prepared=await work();
    assert.equal(prepared.result.state,'AUTHORIZED',JSON.stringify(prepared));
    const c=await read(result.id);
    assert.equal(c.authorization_kind,'TRAINED');
    assert.equal(c.dispatch,null);
    await dispatch(c.id);
    const source=await note(pending,'RMA-TRAINED','CM-TRAINED',100);
    assert.equal((await returns.schedule(db,ws)).queued,1);
    const tracked=await work();
    assert.equal(tracked.result.notes.find(x=>x.id===source).proposed,100);
    assert.equal(await balance(pending.billId),400);
  });

  await t.test('a failed physical QC hold releases only the damaged units at confirmed handoff',async()=>{
    await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,last_unit_cost,minimum_order_quantity,order_multiple,created_at,updated_at)
      VALUES($1,$2,'fixture-supplier',$3,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ws,sku]);
    await quality.save(db,ctx,{supplierId:'fixture-supplier',skuId:sku,locationId:location.id,checklist:['Check packaging'],maxUnits:10,confirmed:'yes'});
    const checked=await bill([{skuId:sku,quantityUnits:3,unitCost:1}],{receipt:true});
    assert(checked.qualityId);
    await quality.inspect(db,ctx,checked.qualityId,{revision:1,decision:'FAIL',physicallyChecked:'yes',damagedQuantity:'1',note:'One damaged box'});
    await browser.get(route).query({holdId:checked.qualityId}).expect(200);
    const prior=await stock(sku);
    await assert.rejects(returns.capture(db,ctx,args(checked,'RMA-QC-WRONG',[{receiptLineId:checked.receiptLines[0].id,quantity:2}],'2.00')),/physically damaged count/);
    const c=await returns.capture(db,ctx,args(checked,'RMA-QC'));
    assert.equal((await stock(sku))[2],prior[2]);
    assert.equal((await work()).result.state,'AUTHORIZED');
    await dispatch(c.id);
    assert.deepEqual(await stock(sku),[prior[0]-1,prior[1],prior[2]-1]);
    const held=await quality.hold(db,ctx,checked.qualityId);
    assert.equal(Number(held.returned_quantity),1);
    assert.equal(held.status,'FAILED');
    assert.equal(held.inspection.damagedQuantity,1);
    const checkedRemaining=await quality.inspect(db,ctx,checked.qualityId,{revision:held.revision,decision:'PASS',physicallyChecked:'yes',checks:['0']});
    if(!checkedRemaining.released){
      const rechecked=await quality.hold(db,ctx,checked.qualityId);
      await quality.release(db,ctx,checked.qualityId,{revision:rechecked.revision,confirmed:'yes'});
    }
    assert.deepEqual(await stock(sku),[prior[0]-1,prior[1],prior[2]-3]);
    assert.equal((await read(c.id)).evidence.lines[0].inspection.damagedQuantity,1);
  });

  await t.test('Custom prepares mixed measured, lot and serial goods without an example',async()=>{
    await f.subscribe('enterprise');
    await authorize(sample,2);
    const savedRule=(await db.query('SELECT example_id FROM stockchief_runtime.agent_supplier_return_rules WHERE workspace_id=$1',[ws])).rows[0];
    assert.equal(savedRule.example_id,null);
    const dual=(await catalog.createItem(db,ctx,{name:'Actual weight return',baseCode:'RETURN-WEIGHT',trackingMode:'quantity',
      unitLabel:'piece',secondaryUnitLabel:'kg'})).skuIds[0];
    const lot=(await catalog.createItem(db,ctx,{name:'Lot return',baseCode:'RETURN-LOT',trackingMode:'lot'})).skuIds[0];
    const serial=(await catalog.createItem(db,ctx,{name:'Serial return',baseCode:'RETURN-SERIAL',trackingMode:'serial'})).skuIds[0];
    const fractional=(await catalog.createItem(db,ctx,{name:'Fractional return',baseCode:'RETURN-FRACTION',trackingMode:'quantity',
      unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'})).skuIds[0];
    const batch=await bill([{skuId:dual,quantityUnits:2,secondaryQuantity:'2.35',unitCost:1},
      {skuId:lot,quantityUnits:2,unitCost:1,receipt:{lotCode:'FAULTY-BATCH'}},
      {skuId:serial,quantityUnits:2,unitCost:1,receipt:{serials:['FAULTY-ONE','FAULTY-TWO']}},
      {skuId:fractional,quantityUnits:'2.5',unitCost:1}]);
    const lines=batch.receiptLines.map(l=>({receiptLineId:l.id,quantity:l.sku_id===fractional?'0.75':1,
      ...(l.sku_id===dual?{secondaryQuantity:'1.125'}:{}),...(l.sku_id===serial?{serials:['FAULTY-ONE']}:{} )}));
    const result=await returns.capture(db,ctx,args(batch,'RMA-MIXED',lines,'3.88'));
    assert.equal(result.queued,true);
    const processed=await work();
    assert.equal(processed.result.state,'AUTHORIZED',JSON.stringify(processed));
    assert.equal((await read(result.id)).authorization_kind,'CUSTOM');
    const picked=(await db.query("SELECT id FROM serial_units WHERE workspace_id=$1 AND serial='FAULTY-ONE'",[ws])).rows[0].id;
    await assert.rejects(require('../../src/domain/postgres-inventory-engine').issue(db,ctx,{skuId:serial,locationId:location.id,
      quantity:1,serialUnitIds:[picked],reasonCode:'count',idempotencyKey:randomUUID()}),/serial.*held/i);
    await dispatch(result.id);
    assert.deepEqual(await stock(dual),[1,1.225,0]);
    assert.deepEqual(await stock(lot),[1,null,0]);
    assert.deepEqual(await stock(fractional),[1.75,null,0]);
    const s=(await db.query("SELECT serial,status FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial",[ws,serial])).rows;
    assert.deepEqual(s,[{serial:'FAULTY-ONE',status:'issued'},{serial:'FAULTY-TWO',status:'in_stock'}]);
    const c=await read(result.id);
    assert.equal(c.dispatch.lines.length,4);
    assert.equal(c.dispatch.lines.every(l=>Boolean(l.journalEntryId)),true);
    const providerEffects=(await db.query("SELECT count(*)::int n FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind IN('mail.outbound.send','payment.refund.create')",[ws])).rows[0].n;
    assert.equal(providerEffects,0);
  });
});
