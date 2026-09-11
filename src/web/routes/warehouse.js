'use strict';

const express = require('express');
const warehouse = require('../../warehouse/service');
const labels = require('../../warehouse/labels');
const locationService = require('../../domain/location-service');
const repo = require('../../domain/repository');
const permissions = require('../../actions/permissions');
const counts = require('../../operations/counts');
const returns = require('../../operations/returns');
const waves = require('../../operations/fulfillment-waves');
const sales = require('../../sales/sales-order-service');
const supplierService = require('../../purchasing/supplier-service');
const prices = require('../../pricing/price-service');
const { ValidationError } = require('../../domain/errors');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/warehouse', requireAuth);

function assertOperate(req) {
  permissions.assertCan(req.user, permissions.OPERATE, 'perform warehouse scans');
}

function assertTaskPermission(req, task) {
  if (task.task_type === 'COUNT') {
    permissions.assertCan(req.user, permissions.ADJUST, 'scan and post warehouse counts');
    return;
  }
  assertOperate(req);
}

function catalogue(db, workspaceId) {
  return db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.is_active = 1
    ORDER BY i.name, s.position, s.code`).all(workspaceId);
}

function lots(db, workspaceId) {
  return db.prepare(`SELECT lots.id, lots.code, lots.sku_id, s.code AS sku_code, i.name AS item_name
    FROM lots JOIN skus s ON s.id = lots.sku_id AND s.workspace_id = lots.workspace_id
    JOIN items i ON i.id = s.item_id AND i.workspace_id = lots.workspace_id
    WHERE lots.workspace_id = ? ORDER BY i.name, lots.code`).all(workspaceId);
}

function supplierReturnEvidence(db, workspaceId) {
  return {
    supplierBills: db.prepare(`SELECT b.id, b.bill_number, b.supplier_invoice_number,
        b.supplier_id, b.balance_minor, b.currency, s.name AS supplier_name
      FROM accounting_supplier_bills b
      JOIN suppliers s ON s.id = b.supplier_id AND s.workspace_id = b.workspace_id
      WHERE b.workspace_id = ? AND b.status IN ('OPEN', 'PARTIALLY_PAID')
      ORDER BY b.issue_date DESC, b.bill_number DESC`).all(workspaceId),
    lots: db.prepare(`SELECT l.id, l.code, l.sku_id, lb.location_id, lb.quantity,
        s.code AS sku_code, i.name AS item_name, loc.name AS location_name
      FROM lots l
      JOIN lot_balances lb ON lb.lot_id = l.id AND lb.workspace_id = l.workspace_id
      JOIN skus s ON s.id = l.sku_id AND s.workspace_id = l.workspace_id
      JOIN items i ON i.id = s.item_id AND i.workspace_id = l.workspace_id
      JOIN locations loc ON loc.id = lb.location_id AND loc.workspace_id = l.workspace_id
      WHERE l.workspace_id = ? AND lb.quantity > 0
      ORDER BY i.name, l.code, loc.name`).all(workspaceId),
    serialUnits: db.prepare(`SELECT su.id, su.serial, su.sku_id, su.location_id,
        s.code AS sku_code, i.name AS item_name, loc.name AS location_name
      FROM serial_units su
      JOIN skus s ON s.id = su.sku_id AND s.workspace_id = su.workspace_id
      JOIN items i ON i.id = s.item_id AND i.workspace_id = su.workspace_id
      JOIN locations loc ON loc.id = su.location_id AND loc.workspace_id = su.workspace_id
      WHERE su.workspace_id = ? AND su.status = 'in_stock'
      ORDER BY i.name, su.serial`).all(workspaceId),
  };
}

router.get('/warehouse', asyncRoute(async (req, res) => {
  res.page('warehouse/index', {
    title: 'Warehouse', nav: 'warehouse', room: true,
    tasks: warehouse.listTasks(req.db, req.ctx.workspaceId),
    locations: locationService.listHierarchy(req.db, req.ctx.workspaceId),
    skus: catalogue(req.db, req.ctx.workspaceId),
    lots: lots(req.db, req.ctx.workspaceId),
    containers: warehouse.listContainers(req.db, req.ctx.workspaceId),
    rules: warehouse.listRules(req.db, req.ctx.workspaceId),
    canOperate: permissions.can(req.user, permissions.OPERATE),
    canAdmin: permissions.can(req.user, permissions.ADMIN),
  });
}));

router.get('/warehouse/operations', asyncRoute(async (req,res)=>{
  const returnLists=returns.listReturns(req.db,req.ctx.workspaceId);
  const orders=sales.listOrders(req.db,req.ctx.workspaceId,{limit:200});
  const returnEvidence=supplierReturnEvidence(req.db,req.ctx.workspaceId);
  res.page('warehouse/operations',{title:'Counts, returns and fulfillment',nav:'warehouse',room:true,
    campaigns:counts.list(req.db,req.ctx.workspaceId),analytics:counts.analytics(req.db,req.ctx.workspaceId),
    countPlans:counts.listPlans(req.db,req.ctx.workspaceId),
    customerReturns:returnLists.customers,supplierReturns:returnLists.suppliers,waves:waves.list(req.db,req.ctx.workspaceId),
    readyOrders:waves.readyOrders(req.db,req.ctx.workspaceId),orders:orders.filter((order)=>Number(order.totals.fulfilled)>0),
    suppliers:supplierService.listSuppliers(req.db,req.ctx.workspaceId),locations:locationService.listHierarchy(req.db,req.ctx.workspaceId),
    skus:catalogue(req.db,req.ctx.workspaceId),...returnEvidence,
  });
}));

router.post('/warehouse/count-plans',asyncRoute(async(req,res)=>{const plan=counts.createPlan(req.db,req.ctx,req.user,{name:req.body.name,countKind:req.body.countKind,
  locationId:req.body.locationId,frequencyDays:req.body.frequencyDays,nextDueDate:req.body.nextDueDate,blindCount:req.body.blindCount!=='0',
  skuIds:req.body.countKind==='FULL'?[]:[req.body.skuId]});req.flash('success',`${plan.name} is scheduled.`);res.redirect(303,'/warehouse/operations#counts');}));
router.post('/warehouse/count-plans/:id/start',asyncRoute(async(req,res)=>{const session=counts.launchPlan(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/counts/${session.id}`);}));

router.post('/warehouse/counts', asyncRoute(async(req,res)=>{
  const session=counts.createCampaign(req.db,req.ctx,req.user,{name:req.body.name,countKind:req.body.countKind,
    locationId:req.body.locationId,blindCount:req.body.blindCount!=='0',skuIds:req.body.countKind==='FULL'?null:[req.body.skuId]});
  res.redirect(303,`/warehouse/counts/${session.id}`);
}));
router.get('/warehouse/counts/:id',asyncRoute(async(req,res)=>res.page('warehouse/count',{title:'Physical count',nav:'warehouse',room:true,session:counts.requireSession(req.db,req.ctx.workspaceId,req.params.id)})));
router.post('/warehouse/counts/:id/lines/:lineId',asyncRoute(async(req,res)=>{counts.recordCount(req.db,req.ctx,req.user,req.params.id,req.params.lineId,req.body.quantity,req.body.note);res.redirect(303,`/warehouse/counts/${req.params.id}`);}));
router.post('/warehouse/counts/:id/submit',asyncRoute(async(req,res)=>{const result=counts.submit(req.db,req.ctx,req.user,req.params.id);req.flash('success',result.status==='RECOUNT_REQUIRED'?'The blind count found a variance. A second blind pass is required.':result.status==='AWAITING_APPROVAL'?'Count submitted. A separate variance approval is required.':'Count matched the records. No stock changed.');res.redirect(303,`/warehouse/counts/${req.params.id}`);}));
router.post('/warehouse/counts/:id/recount',asyncRoute(async(req,res)=>{const next=counts.startRecount(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/counts/${next.id}`);}));
router.post('/warehouse/counts/:id/approve',asyncRoute(async(req,res)=>{counts.approve(req.db,req.ctx,req.user,req.params.id);req.flash('success','Variance approved, posted through the inventory engine, and verified.');res.redirect(303,`/warehouse/counts/${req.params.id}`);}));

router.post('/warehouse/returns/customer',asyncRoute(async(req,res)=>{const order=sales.getOrder(req.db,req.ctx.workspaceId,req.body.salesOrderId);const line=order.lines.find((entry)=>entry.id===req.body.salesOrderLineId);if(!line)throw new ValidationError('Choose a returned product from the selected customer order.');const created=returns.requestCustomerReturn(req.db,req.ctx,req.user,{salesOrderId:order.id,quarantineLocationId:req.body.quarantineLocationId,resolution:req.body.resolution,reason:req.body.reason,lines:[{salesOrderLineId:line.id,quantity:req.body.quantity}]});res.redirect(303,`/warehouse/returns/customer/${created.id}`);}));
router.get('/warehouse/returns/customer/:id',asyncRoute(async(req,res)=>res.page('warehouse/customer-return',{title:'Customer return',nav:'warehouse',room:true,record:returns.getCustomerReturn(req.db,req.ctx.workspaceId,req.params.id),locations:locationService.listHierarchy(req.db,req.ctx.workspaceId),skus:catalogue(req.db,req.ctx.workspaceId)})));
router.post('/warehouse/returns/customer/:id/authorize',asyncRoute(async(req,res)=>{returns.authorizeCustomerReturn(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/returns/customer/${req.params.id}`);}));
router.post('/warehouse/returns/customer/:id/receive',asyncRoute(async(req,res)=>{const record=returns.getCustomerReturn(req.db,req.ctx.workspaceId,req.params.id);returns.receiveCustomerReturn(req.db,req.ctx,req.user,req.params.id,{lines:[{lineId:req.body.lineId||record.lines[0].id,quantity:req.body.quantity,lotCode:req.body.lotCode,serials:String(req.body.serials||'').split(/[\r\n,]+/).map((x)=>x.trim()).filter(Boolean)}]});res.redirect(303,`/warehouse/returns/customer/${req.params.id}`);}));
router.post('/warehouse/returns/customer/:id/inspect',asyncRoute(async(req,res)=>{const record=returns.getCustomerReturn(req.db,req.ctx.workspaceId,req.params.id);returns.inspectCustomerReturn(req.db,req.ctx,req.user,req.params.id,{lines:[{lineId:req.body.lineId||record.lines[0].id,restock:req.body.restock||0,scrap:req.body.scrap||0,repair:req.body.repair||0,restockLocationId:req.body.restockLocationId,repairLocationId:req.body.repairLocationId,conditionNote:req.body.conditionNote}]});res.redirect(303,`/warehouse/returns/customer/${req.params.id}`);}));
router.post('/warehouse/returns/customer/:id/refund',asyncRoute(async(req,res)=>{returns.refundCustomerReturn(req.db,req.ctx,req.user,req.params.id,{revenueMinor:prices.toMinor(req.body.revenue,'Refund amount'),taxMinor:prices.toMinor(req.body.tax||'0','Refund tax'),cogsMinor:prices.toMinor(req.body.cogs||'0','Returned cost'),destination:req.body.destination});res.redirect(303,`/warehouse/returns/customer/${req.params.id}`);}));
router.post('/warehouse/returns/customer/:id/exchange',asyncRoute(async(req,res)=>{returns.exchangeCustomerReturn(req.db,req.ctx,req.user,req.params.id,{lines:[{skuId:req.body.skuId,quantity:req.body.quantity}]});res.redirect(303,`/warehouse/returns/customer/${req.params.id}`);}));

router.post('/warehouse/returns/supplier',asyncRoute(async(req,res)=>{const serialUnitIds=Array.isArray(req.body.serialUnitIds)?req.body.serialUnitIds:[req.body.serialUnitIds].filter(Boolean);const created=returns.requestSupplierReturn(req.db,req.ctx,req.user,{supplierId:req.body.supplierId,supplierBillId:trimOrNull(req.body.supplierBillId),expectedCreditMinor:req.body.expectedCredit?prices.toMinor(req.body.expectedCredit,'Expected credit'):null,reason:req.body.reason,lines:[{skuId:req.body.skuId,locationId:req.body.locationId,quantity:req.body.quantity,lotId:trimOrNull(req.body.lotId),serialUnitIds}]});res.redirect(303,`/warehouse/returns/supplier/${created.id}`);}));
router.get('/warehouse/returns/supplier/:id',asyncRoute(async(req,res)=>res.page('warehouse/supplier-return',{title:'Supplier return',nav:'warehouse',room:true,record:returns.getSupplierReturn(req.db,req.ctx.workspaceId,req.params.id)})));
router.post('/warehouse/returns/supplier/:id/authorize',asyncRoute(async(req,res)=>{returns.authorizeSupplierReturn(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/returns/supplier/${req.params.id}`);}));
router.post('/warehouse/returns/supplier/:id/ship',asyncRoute(async(req,res)=>{returns.shipSupplierReturn(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/returns/supplier/${req.params.id}`);}));
router.post('/warehouse/returns/supplier/:id/credit',asyncRoute(async(req,res)=>{returns.reconcileSupplierReturn(req.db,req.ctx,req.user,req.params.id,{amountMinor:prices.toMinor(req.body.amount,'Supplier credit'),creditNumber:req.body.creditNumber,creditDate:req.body.creditDate});res.redirect(303,`/warehouse/returns/supplier/${req.params.id}`);}));

router.post('/warehouse/waves',asyncRoute(async(req,res)=>{const created=waves.create(req.db,req.ctx,req.user,{strategy:req.body.strategy,title:req.body.title,orderIds:Array.isArray(req.body.orderIds)?req.body.orderIds:[req.body.orderIds].filter(Boolean)});res.redirect(303,`/warehouse/waves/${created.id}`);}));
router.get('/warehouse/waves/:id',asyncRoute(async(req,res)=>res.page('warehouse/wave',{title:'Fulfillment wave',nav:'warehouse',room:true,wave:waves.get(req.db,req.ctx.workspaceId,req.params.id),containers:warehouse.listContainers(req.db,req.ctx.workspaceId)})));
router.post('/warehouse/waves/:id/scans',asyncRoute(async(req,res)=>{const result=waves.scan(req.db,req.ctx,req.user,req.params.id,{...req.body,lotBarcode:req.body.lotBarcode,serialBarcode:req.body.serialBarcode});req.flash(result.status==='ACCEPTED'?'success':'error',result.duplicate?`Already received that scan: ${result.message}`:result.message);res.redirect(303,`/warehouse/waves/${req.params.id}`);}));
router.post('/warehouse/waves/:id/shortage',asyncRoute(async(req,res)=>{waves.reportShortage(req.db,req.ctx,req.user,req.params.id,req.body.lineId,req.body.foundQuantity,req.body.note);res.redirect(303,`/warehouse/waves/${req.params.id}`);}));
router.post('/warehouse/waves/:id/pack',asyncRoute(async(req,res)=>{waves.packShipment(req.db,req.ctx,req.user,req.params.id,req.body.shipmentId,{containerId:req.body.containerId,packageCount:req.body.packageCount,weightGrams:req.body.weightGrams});res.redirect(303,`/warehouse/waves/${req.params.id}`);}));
router.post('/warehouse/waves/:id/refresh',asyncRoute(async(req,res)=>{waves.refresh(req.db,req.ctx,req.user,req.params.id);res.redirect(303,`/warehouse/waves/${req.params.id}`);}));

router.post('/warehouse/tasks', asyncRoute(async (req, res) => {
  assertOperate(req);
  const task = warehouse.createTask(req.db, req.ctx, {
    taskType: req.body.taskType,
    title: req.body.title,
    reference: req.body.reference,
    containerId: trimOrNull(req.body.containerId),
    lines: [{
      skuId: req.body.skuId,
      fromLocationId: trimOrNull(req.body.fromLocationId),
      toLocationId: trimOrNull(req.body.toLocationId),
      lotId: trimOrNull(req.body.lotId),
      quantity: req.body.quantity,
    }],
  });
  req.flash('success', `Task ${task.task_number} is ready to scan.`);
  res.redirect(303, `/warehouse/tasks/${task.id}`);
}));

router.get('/warehouse/tasks/:id', asyncRoute(async (req, res) => {
  const task = warehouse.getTask(req.db, req.ctx.workspaceId, req.params.id);
  res.page('warehouse/task', {
    title: `Warehouse task ${task.task_number}`, nav: 'warehouse', room: true,
    task,
    canScan: task.task_type === 'COUNT'
      ? permissions.can(req.user, permissions.ADJUST)
      : permissions.can(req.user, permissions.OPERATE),
  });
}));

router.post('/warehouse/tasks/:id/scans', asyncRoute(async (req, res) => {
  const task = warehouse.getTask(req.db, req.ctx.workspaceId, req.params.id);
  assertTaskPermission(req, task);
  const result = warehouse.scanTask(req.db, req.ctx, {
    taskId: req.params.id,
    clientScanId: req.body.clientScanId,
    deviceId: req.body.deviceId,
    locationBarcode: req.body.locationBarcode,
    itemBarcode: req.body.itemBarcode,
    lotBarcode: req.body.lotBarcode,
    serialBarcode: req.body.serialBarcode,
    quantity: req.body.quantity,
  });
  req.flash(result.accepted ? 'success' : 'error', result.duplicate
    ? `Already received that offline scan: ${result.message}` : result.message);
  res.redirect(303, `/warehouse/tasks/${req.params.id}#scan`);
}));

router.post('/warehouse/tasks/:id/count-finish', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.ADJUST, 'post a warehouse count');
  warehouse.finishCount(req.db, req.ctx, req.params.id, { confirmEmpty: req.body.confirmEmpty === '1' });
  req.flash('success', 'The count was posted through the inventory engine and verified.');
  res.redirect(303, `/warehouse/tasks/${req.params.id}`);
}));

router.post('/warehouse/tasks/:id/status', asyncRoute(async (req, res) => {
  assertOperate(req);
  const task = warehouse.setTaskStatus(req.db, req.ctx, req.params.id, req.body.status);
  req.flash('success', `Task ${task.task_number} is now ${task.status.toLowerCase()}.`);
  res.redirect(303, `/warehouse/tasks/${req.params.id}`);
}));

router.post('/warehouse/containers', asyncRoute(async (req, res) => {
  assertOperate(req);
  const container = warehouse.createContainer(req.db, req.ctx, req.body);
  req.flash('success', `${container.code} is ready.`);
  res.redirect(303, '/warehouse#containers');
}));

router.post('/warehouse/putaway-rules', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.ADMIN, 'change putaway rules');
  warehouse.createPutawayRule(req.db, req.ctx, {
    skuId: trimOrNull(req.body.skuId),
    fromLocationId: trimOrNull(req.body.fromLocationId),
    destinationLocationId: req.body.destinationLocationId,
    priority: req.body.priority,
  });
  req.flash('success', 'Putaway rule saved. It will choose a destination only when the rule matches.');
  res.redirect(303, '/warehouse#putaway');
}));

router.post('/warehouse/barcodes', asyncRoute(async (req, res) => {
  permissions.assertCan(req.user, permissions.ADMIN, 'manage barcode aliases');
  warehouse.createAlias(req.db, req.ctx, req.body);
  req.flash('success', 'Barcode alias saved.');
  res.redirect(303, '/warehouse#barcodes');
}));

router.get('/warehouse/labels/:kind/:id', asyncRoute(async (req, res) => {
  const label = labels.labelFor(req.db, req.ctx.workspaceId, req.params.kind, req.params.id);
  res.page('warehouse/label', {
    title: `Print ${label.title}`, nav: 'warehouse', room: true,
    label, barcodeSvg: labels.code128Svg(label.barcode), verified: labels.verifyRoundTrip(label),
  });
}));

module.exports = router;
