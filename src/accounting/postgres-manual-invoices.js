'use strict';

const ledger=require('./postgres-ledger');
const {newId,nowIso,requireText,trimOrNull}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');

function date(value,label){
  const text=String(value||'').trim();
  const parsed=Date.parse(`${text}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==text)
    throw new ValidationError(`${label} must be a valid date.`);
  return text;
}

function minor(value,label,allowZero=false){
  const text=String(value??'').trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))throw new ValidationError(`${label} must be a money amount.`);
  const amount=Math.round(Number(text)*100);
  if(!Number.isSafeInteger(amount)||(allowZero?amount<0:amount<=0))throw new ValidationError(`${label} is invalid.`);
  return amount;
}

async function createCustomerInvoice(database,ctx,input){
  return database.transaction((client)=>createCustomerInvoiceInTransaction(client,ctx,input),
    {isolation:'SERIALIZABLE',retrySafe:true});
}

async function createCustomerInvoiceInTransaction(client,ctx,input){
  const customerId=String(input.customerId||'');
  const description=requireText(input.description,'Description',{max:250});
  const quantity=Number(input.quantity);
  if(!Number.isFinite(quantity)||quantity<=0||quantity>1000000)throw new ValidationError('Quantity must be positive.');
  const unitPriceMinor=minor(input.unitAmount,'Unit price');
  const subtotalMinor=Math.round(quantity*unitPriceMinor);
  if(!Number.isSafeInteger(subtotalMinor)||subtotalMinor<=0)throw new ValidationError('Invoice total is invalid.');
  const taxMinor=minor(input.tax||'0','Tax',true);
  const totalMinor=subtotalMinor+taxMinor;
  if(!Number.isSafeInteger(totalMinor))throw new ValidationError('Invoice total is invalid.');
  const issueDate=date(input.issueDate,'Issue date');
  const dueDate=input.dueDate?date(input.dueDate,'Due date'):null;
  if(dueDate&&dueDate<issueDate)throw new ValidationError('Due date cannot be before the issue date.');
  const requestKey=requireText(input.idempotencyKey,'Invoice request key',{max:160});
  const sourceKey=`manual-customer-invoice:${requestKey}`;
  return (async()=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`invoice:${ctx.workspaceId}`]);
    const existing=(await client.query(`SELECT id,invoice_number FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND source_key=$2`,[ctx.workspaceId,sourceKey])).rows[0];
    if(existing)return {...existing,replayed:true};
    const customer=(await client.query(`SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,
      [ctx.workspaceId,customerId])).rows[0];
    if(!customer)throw new NotFoundError('Choose an active customer in this inventory.');
    const currency=(await client.query(`SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1`,
      [ctx.workspaceId])).rows[0]?.base_currency;
    if(!currency)throw new ValidationError('Configure accounting before recording invoices.');
    const count=Number((await client.query('SELECT COUNT(*) AS count FROM accounting_customer_invoices WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count);
    let invoiceNumber=trimOrNull(input.documentNumber);
    if(!invoiceNumber){
      let nextNumber=count+1;
      while(true){
        const candidate=`INV-${String(nextNumber).padStart(4,'0')}`;
        const taken=(await client.query(`SELECT 1 FROM accounting_customer_invoices
          WHERE workspace_id=$1 AND invoice_number=$2`,[ctx.workspaceId,candidate])).rows.length;
        if(!taken){invoiceNumber=candidate;break;}
        nextNumber+=1;
      }
    }
    const invoiceId=newId('arinvoice');
    const lines=[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:totalMinor,customerId},
      {accountKey:'SALES_REVENUE',creditMinor:subtotalMinor,customerId}];
    if(taxMinor)lines.push({accountKey:'SALES_TAX_PAYABLE',creditMinor:taxMinor,customerId});
    const posted=await ledger.postInTransaction(client,ctx,{postingDate:issueDate,sourceKey:`journal:${sourceKey}`,
      sourceType:'manual_customer_invoice',sourceRecordType:'customer_invoice',sourceRecordId:invoiceId,
      description:`Customer invoice ${invoiceNumber}`,currency,createdByType:'USER',lines});
    const revenueAccount=(await client.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1
      AND system_key='SALES_REVENUE' AND active=1`,[ctx.workspaceId])).rows[0];
    if(!revenueAccount)throw new ValidationError('Sales revenue account is not configured.');
    const at=nowIso();
    await client.query(`INSERT INTO accounting_customer_invoices
      (id,workspace_id,invoice_number,customer_id,issue_date,due_date,status,currency,subtotal_minor,tax_minor,
       total_minor,balance_minor,journal_entry_id,source_key,notes,created_by_user_id,created_at,updated_at,opened_at)
      VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$15,$15)`,
    [invoiceId,ctx.workspaceId,invoiceNumber,customerId,issueDate,dueDate,currency,subtotalMinor,taxMinor,
      totalMinor,posted.entry.id,sourceKey,trimOrNull(input.notes),ctx.actorId,at]);
    await client.query(`INSERT INTO accounting_customer_invoice_lines
      (id,workspace_id,invoice_id,line_number,description,quantity,unit_price_minor,line_total_minor,revenue_account_id,created_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)`,
    [newId('arline'),ctx.workspaceId,invoiceId,description,quantity,unitPriceMinor,subtotalMinor,revenueAccount.id,at]);
    return {id:invoiceId,invoice_number:invoiceNumber,replayed:false};
  })();
}

module.exports={createCustomerInvoice,createCustomerInvoiceInTransaction};
