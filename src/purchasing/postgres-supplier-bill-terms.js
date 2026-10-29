'use strict';
const {ValidationError}=require('../domain/errors'),{newId}=require('../lib/util');
function dueDate(value,issueDate){const date=String(value||''),stamp=Date.parse(date);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==date||date<issueDate)throw new ValidationError('Confirm a real due date on or after the supplier invoice date.');return date;}
async function prepare(_db,_ctx,bill,args){
 if(['VOID','PAID'].includes(bill.status))throw new ValidationError('Only an unpaid supplier bill can have its payment terms confirmed.');
 const reason=String(args.reason||'').trim();if(reason.length<5||reason.length>1000)throw new ValidationError('Give the supplier evidence or agreed terms supporting this due date.');
 const date=dueDate(args.dueDate,bill.issue_date);
 return {payload:{recordId:bill.id,dueDate:date,reason,expectedUpdatedAt:new Date(bill.updated_at).toISOString(),previousDueDate:bill.due_date||null},summary:`Confirm ${bill.bill_number} is due ${date}${bill.due_date?' (previously '+bill.due_date+')':''}. Evidence: ${reason}. Amount, invoice source, posted books, stock and payments stay unchanged.`};
}
async function execute(client,ctx,p){
 const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],access=require('../actions/permissions');access.assertCan(actor,access.MANAGE_ACCOUNTING,'confirm supplier payment terms');
 const bill=(await client.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.recordId])).rows[0];if(!bill||['PAID','VOID'].includes(bill.status)||new Date(bill.updated_at).toISOString()!==p.expectedUpdatedAt)throw new ValidationError('This bill changed after its terms were reviewed. Review its current balance and due date.');
 dueDate(p.dueDate,bill.issue_date);const at=new Date().toISOString(),detail=typeof bill.exception_detail==='string'?JSON.parse(bill.exception_detail||'{}'):bill.exception_detail||{},history=[...(detail.termsHistory||[]),{from:bill.due_date||null,to:p.dueDate,reason:p.reason,at,actorId:ctx.actorId}];
 await client.query('UPDATE accounting_supplier_bills SET due_date=$3,exception_detail=$4,updated_at=$5 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,bill.id,p.dueDate,JSON.stringify({...detail,termsHistory:history}),at]);
 await require('../operations/postgres-workflow-ownership').capture(client,ctx,'supplier_invoice',bill.id,{id:'terms:'+newId('event'),kind:'supplier_bill.confirm_due_date'});
 return {billId:bill.id,dueDate:p.dueDate,totalMinor:Number(bill.total_minor),balanceMinor:Number(bill.balance_minor)};
}
module.exports={prepare,execute};
