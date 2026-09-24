'use strict';

const express = require('express');
const inventory = require('../../domain/postgres-inventory-engine');
const workflows = require('../../operations/postgres-business-workflows');
const ledger = require('../../accounting/postgres-ledger');
const transfers = require('../../transfers/postgres-transfer-service');
const { AuthenticationError } = require('../../domain/errors');

function createPostgresBusinessRouter(database) {
  const router=express.Router();
  router.use((req,res,next)=>req.user?next():next(new AuthenticationError('Sign in to continue.')));
  const command=(operation,status=200)=>async(req,res,next)=>{
    try { return res.status(status).json({ok:true,result:await operation(req)}); }
    catch(error){ return next(error); }
  };
  router.post('/inventory/receive',command((req)=>inventory.receive(database,req.ctx,req.body),201));
  router.post('/inventory/issue',command((req)=>inventory.issue(database,req.ctx,req.body),201));
  router.post('/inventory/transfer',command((req)=>inventory.transfer(database,req.ctx,req.body),201));
  router.post('/transfers',command((req)=>transfers.request(database,req.ctx,req.body),201));
  router.post('/transfers/:id/approve',command((req)=>transfers.approve(database,req.ctx,req.params.id,req.body)));
  router.post('/transfers/:id/pick',command((req)=>transfers.pick(database,req.ctx,req.params.id,req.body)));
  router.post('/transfers/:id/dispatch',command((req)=>transfers.dispatch(database,req.ctx,req.params.id,req.body)));
  router.post('/transfers/:id/in-transit',command((req)=>transfers.markInTransit(database,req.ctx,req.params.id,req.body)));
  router.post('/transfers/:id/receive',command((req)=>transfers.receive(database,req.ctx,req.params.id,req.body)));
  router.post('/transfers/:id/cancel',command((req)=>transfers.cancel(database,req.ctx,req.params.id,req.body)));
  router.post('/inventory/count',command((req)=>inventory.adjust(database,req.ctx,req.body),201));
  router.post('/purchasing/orders',command((req)=>workflows.createPurchaseOrder(database,req.ctx,req.body),201));
  router.post('/purchasing/orders/:id/approve',command((req)=>workflows.approvePurchaseOrder(database,req.ctx,req.params.id,req.body)));
  router.post('/purchasing/orders/:id/place',command((req)=>workflows.placePurchaseOrder(database,req.ctx,req.params.id,req.body)));
  router.post('/purchasing/orders/:id/receive',command((req)=>workflows.receivePurchaseOrder(database,req.ctx,req.params.id,req.body)));
  router.post('/purchasing/invoices',command((req)=>workflows.recordSupplierInvoice(database,req.ctx,req.body),201));
  router.post('/purchasing/payments',command((req)=>workflows.recordSupplierPayment(database,req.ctx,req.body),201));
  router.post('/sales/orders',command((req)=>workflows.createSalesOrder(database,req.ctx,req.body),201));
  router.post('/sales/orders/:id/confirm',command((req)=>workflows.confirmSalesOrder(database,req.ctx,req.params.id,req.body)));
  router.post('/sales/orders/:id/fulfill',command((req)=>workflows.fulfillSalesOrder(database,req.ctx,req.params.id,req.body)));
  router.post('/sales/payments',command((req)=>workflows.recordCustomerPayment(database,req.ctx,req.body),201));
  router.post('/accounting/journals',command((req)=>ledger.post(database,req.ctx,req.body),201));
  return router;
}

module.exports = { createPostgresBusinessRouter };
