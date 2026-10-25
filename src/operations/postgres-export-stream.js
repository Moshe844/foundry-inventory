'use strict';

const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {ZipFile}=require('yazl');
const {ValidationError,RateLimitError}=require('../domain/errors');
const tables=require('./postgres-export-tables');
let active=0;
const numericTypes=new Set([20,21,23,700,701,1700]);
function cell(value,{numeric=false}={}){
  let text=value==null?'':value instanceof Date?value.toISOString():typeof value==='object'?JSON.stringify(value):String(value);
  if((numeric||typeof value==='number')&&/^-?\d+(?:\.\d+)?$/.test(text))return text;
  // Spreadsheet programs must not execute imported names, notes or codes.
  if(typeof value==='string'&&/^[\s]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
function line(values,numericColumns=[]){return values.map((value,index)=>cell(value,{numeric:Boolean(numericColumns[index])})).join(',')+'\r\n';}
function queries(itemIds){
 const currency=require('../domain/currency'),groups=new Map();for(const code of [...Intl.supportedValuesOf('currency'),'CLF','UYW']){const n=currency.exponent(code);if(n!==2){if(!groups.has(n))groups.set(n,[]);groups.get(n).push(code);}}
 const divisor='CASE '+[...groups].map(([n,codes])=>"WHEN p.currency IN ("+codes.map(c=>"'"+c+"'").join(',')+") THEN "+10**n).join(' ')+' ELSE 100 END';
 const inventory=`SELECT i.name AS "Product",i.base_code AS "Item code",s.code AS "SKU",s.variant_label AS "Variant",
 i.unit_label AS "Unit",l.name AS "Location",coalesce(b.on_hand,0) AS "On hand",p.amount_minor AS "Selling price (minor)",p.amount_minor::numeric/(${divisor}) AS "Selling price",
 p.currency AS "Price currency",c.quantity_units AS "Units with recorded cost",c.total_cost_minor AS "Inventory value (minor)",a.base_currency AS "Book currency"
 FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id
 LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
 LEFT JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
 LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
 LEFT JOIN accounting_settings a ON a.workspace_id=i.workspace_id
 LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
 WHERE i.workspace_id=$1${itemIds?' AND i.id=ANY($2::text[])':''}`;
 const selected=[['Products','SELECT * FROM items WHERE workspace_id=$1 AND id=ANY($2::text[])'],
 ['SKUs and variants','SELECT * FROM skus WHERE workspace_id=$1 AND item_id=ANY($2::text[])'],
 ['Stock by location','SELECT b.* FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id WHERE b.workspace_id=$1 AND s.item_id=ANY($2::text[])'],
 ['Stock movements','SELECT * FROM movements WHERE workspace_id=$1 AND item_id=ANY($2::text[])'],
 ['Imported source details','SELECT f.* FROM catalog_source_facts f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id WHERE f.workspace_id=$1 AND s.item_id=ANY($2::text[])']];
 return [['Inventory',inventory],...(itemIds?selected:tables.map(([name,table])=>[name,`SELECT * FROM ${table} WHERE workspace_id=$1`]))];
}
async function download(database,workspaceId,res,{itemIds=null}={}){
 if(active>=2)throw new RateLimitError('Two exports are already downloading. Please try again after one finishes.');
 if(itemIds&&(!Array.isArray(itemIds)||!itemIds.length))throw new ValidationError('Select products to export.');
 active++;
 const controller=new AbortController();let source;let transfer;let cancelledByClient=false;
 const closed=()=>{if(!res.writableFinished){if(!controller.signal.aborted)cancelledByClient=true;controller.abort();}};res.on('close',closed);
 try{return await database.transaction(async client=>{
  const workspace=(await client.query('SELECT name FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
  if(!workspace)throw new ValidationError('This inventory is not available.');
  const safe=workspace.name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,100)||'inventory';
  res.setHeader('Content-Type','application/zip');
  res.setHeader('Content-Disposition',`attachment; filename="${safe}-${new Date().toISOString().slice(0,10)}.zip"`);
  res.setHeader('Cache-Control','no-store');
  const zip=new ZipFile();const counts={};
  transfer=pipeline(zip.outputStream,res,{signal:controller.signal});transfer.catch(()=>{});
  controller.signal.addEventListener('abort',()=>source?.destroy(new Error('Export download cancelled.')),{once:true});
  let index=0;
  for(const [name,sql]of queries(itemIds)){
   if(controller.signal.aborted)throw new Error('Export download cancelled.');
   const cursor='inventory_export_'+index++;
   await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`,itemIds?[workspaceId,itemIds]:[workspaceId]);
   let resolveDone,rejectDone;const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
   source=Readable.from((async function*(){let count=0;let first=true;
    try{yield '\ufeff';for(;;){if(controller.signal.aborted)throw new Error('Export download cancelled.');
     const batch=await client.query(`FETCH FORWARD 500 FROM ${cursor}`);
     if(first){yield line(batch.fields.map(f=>f.name));first=false;}
     for(const row of batch.rows){yield line(batch.fields.map(f=>row[f.name]),batch.fields.map(f=>numericTypes.has(f.dataTypeID)));count++;}
     if(batch.rows.length<500)break;
    }counts[name]=count;resolveDone();}
    catch(error){rejectDone(error);throw error;}
   })());
   source.on('error',error=>{rejectDone(error);controller.abort();});
   source.on('close',()=>{if(controller.signal.aborted)rejectDone(new Error('Export download cancelled.'));});
   zip.addReadStream(source,name+'.csv',{forceZip64Format:true});
   await done;await client.query(`CLOSE ${cursor}`);
  }
  const info=[['StockChief — current inventory export'],['Inventory',workspace.name],['Exported at (UTC)',new Date().toISOString()],
   ['Scope',itemIds?'Selected products in this inventory':'This inventory only; not other businesses'],
   ['Money','Minor amounts are exact currency units (USD cents, JPY yen). Keep the currency column. Selling price is also supplied in major currency units in its own numeric column.'],
   ['Data','CSV files open in spreadsheet programs. All rows share one database snapshot.'],
   ['Imported source details','Additional source fields are retained in the attributes JSON column.'],[],['File','Records'],...Object.entries(counts)];
  info.push(['Custody','Rental, consignment and inspection locations are protected from ordinary sales availability. Agreement records distinguish our assets from supplier-owned goods.']);
  zip.addBuffer(Buffer.from('\ufeff'+info.map(row=>line(row)).join('')),'Read me.csv');zip.end({forceZip64Format:true});
  await transfer;return {counts};
 },{isolation:'REPEATABLE READ',readOnly:true,statementTimeoutMs:120000});}
 catch(error){controller.abort();source?.destroy();if(transfer)await transfer.catch(()=>{});if(cancelledByClient)return {cancelled:true};throw error;}
 finally{res.off('close',closed);active--;}
}
module.exports={download,cell,line,queries};
