'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('Ask price proposals preserve zero, two and three-decimal currency amounts without executing records',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Currency fixture',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const code='UNIT-'+randomUUID(),sku=(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Unfamiliar component',baseCode:code,trackingMode:'quantity'})).skuIds[0],assistant=require('../../src/assistant/postgres-service');
 const at=new Date().toISOString(),customer='customer-'+randomUUID(),supplier='supplier-'+randomUUID(),location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Collection bay',kind:'warehouse'});
 await db.query("INSERT INTO customers(id,workspace_id,name,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Fixture customer','ACTIVE',$3,$4,$4)",[customer,ctx.workspaceId,ctx.actorId,at]);
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES($1,$2,'Fixture supplier','active','USD',$3,$3)",[supplier,ctx.workspaceId,at]);
 for(const currency of ['JPY','USD','KWD'])for(const action of ['set_price','set_purchase_cost']){
  const amount=currency==='JPY'?19:currency==='USD'?19.25:19.257,expected=currency==='JPY'?19:currency==='USD'?1925:19257;
  const result=await assistant.prepareAction(db,ctx,'Prepare the exact recorded monetary amount.',{action,sku:code,amount,currency});assert.equal(result.status,'PREPARED',JSON.stringify(result));const proposal=await assistant.getProposal(db,ctx.workspaceId,result.proposal.id);assert.equal(proposal.payload.amountMinor,expected);assert.equal(proposal.payload.currency,currency);assert.equal(proposal.status,'PENDING');
 }
 for(const [currency,amount,expected]of [['JPY',19,19],['USD',19.25,1925],['KWD',19.257,19257]]){
  const order=await assistant.prepareAction(db,ctx,'Prepare the exact customer pickup price.',{action:'create_sales_order',sku:code,quantity:1,amount,currency,customer:'Fixture customer',deliveryMethod:'pickup',location:location.name});assert.equal(order.status,'PREPARED',JSON.stringify(order));const draft=await assistant.getProposal(db,ctx.workspaceId,order.proposal.id);assert.equal(draft.payload.lines[0].unitPriceMinor,expected);assert.equal(draft.payload.currency,currency);
  const bill='bill-'+randomUUID(),number='B-'+currency;await db.query(`INSERT INTO accounting_supplier_bills(id,workspace_id,bill_number,supplier_id,issue_date,status,currency,total_minor,balance_minor,source_key,created_at,updated_at) VALUES($1,$2,$3,$4,'2026-10-21','OPEN',$5,1000000,1000000,$1,$6,$6)`,[bill,ctx.workspaceId,number,supplier,currency,at]);
  const payment=await assistant.prepareAction(db,ctx,'Prepare the exact recorded supplier payment.',{action:'record_supplier_payment',supplier:'Fixture supplier',supplierBill:number,amount,currency,paymentDate:'2026-10-21',paymentMethod:'cash'});assert.equal(payment.status,'PREPARED',JSON.stringify(payment));const recorded=await assistant.getProposal(db,ctx.workspaceId,payment.proposal.id);assert.equal(recorded.payload.amountMinor,expected);assert.equal(recorded.payload.currency,currency);
 }
 await assert.rejects(assistant.prepareAction(db,ctx,'Prepare a currency-invalid precision.',{action:'set_price',sku:code,amount:19.25,currency:'JPY'}),error=>error.code==='validation_error'&&/fraction smaller than the currency supports/.test(error.message));
 const current=await require('../../src/pricing/postgres-service').currentPrice(db,ctx.workspaceId,sku);assert.equal(current.isSet,false);assert.equal(await require('../../src/pricing/postgres-service').purchaseCost(db,ctx.workspaceId,sku),null);
 assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
