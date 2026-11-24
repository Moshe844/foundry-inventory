'use strict';
// Independent audit of finished synthetic imports. It re-reads the original
// CSV sources and compares every product-and-location with the database, and
// checks row status, one movement per stock row, duplicate receipts, stock
// value and the ledger. It uses no import-engine code, only the exact decimal
// helpers, so an engine change cannot also change what "correct" means.
// The synthetic sources are plain comma-separated text without quoting.
const fs=require('node:fs'),readline=require('node:readline'),exact=require('../../src/domain/exact-quantity');
const KEY='\u0000';
async function expected(sources){
 const positions=new Map();let stockRows=0,units='0',value=0n;const rowsByPlan=new Map();
 for(const source of sources){
  let header=null,rows=0;
  for await(const line of readline.createInterface({input:fs.createReadStream(source.file),crlfDelay:Infinity})){
   if(!line)continue;const cells=line.split(',');
   if(!header){header=new Map(cells.map((name,index)=>[name.trim(),index]));continue;}
   rows++;
   if(!header.has('Quantity'))continue;
   const quantity=cells[header.get('Quantity')],cost=exact.costMinor(quantity,Number(cells[header.get('Unit cost')])*100);
   const key=cells[header.get('SKU')]+KEY+cells[header.get('Location')],current=positions.get(key)||{units:'0',value:0n};
   positions.set(key,{units:exact.add(current.units,quantity),value:current.value+BigInt(cost)});
   stockRows++;units=exact.add(units,quantity);value+=BigInt(cost);
  }
  rowsByPlan.set(source.planId,{file:source.file,rows,stock:header?.has('Quantity')||false});
 }
 return {positions,stockRows,units,value,rowsByPlan};
}
async function audit(db,workspaceId,sources){
 const want=await expected(sources),problems=[],note=text=>{if(problems.length<20)problems.push(text);};
 const same=(a,b)=>exact.canonical(String(a),{signed:true})===exact.canonical(String(b),{signed:true});
 // Every product-and-location, paged in key order.
 let after=['',''],seen=0,matched=0;
 for(;;){
  const page=(await db.query(`SELECT b.sku_id,b.location_id,s.code,l.name,b.on_hand::text units,
    coalesce(c.total_cost_minor,0)::text value,coalesce(c.quantity_units,0)::text costed
   FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
   LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
   WHERE b.workspace_id=$1 AND (b.sku_id,b.location_id)>($2,$3) ORDER BY b.sku_id,b.location_id LIMIT 50000`,[workspaceId,...after])).rows;
  if(!page.length)break;after=[page.at(-1).sku_id,page.at(-1).location_id];
  for(const row of page){
   if(same(row.units,0)&&same(row.value,0))continue;seen++;
   const target=want.positions.get(row.code+KEY+row.name);
   if(!target){note(`unexpected stock ${row.code} @ ${row.name}: ${row.units}`);continue;}
   if(!same(row.units,target.units))note(`${row.code} @ ${row.name}: on hand ${row.units}, file says ${target.units}`);
   else if(BigInt(row.value)!==target.value)note(`${row.code} @ ${row.name}: value ${row.value}, file says ${target.value}`);
   else if(!same(row.costed,row.units))note(`${row.code} @ ${row.name}: valued units ${row.costed} differ from on hand ${row.units}`);
   else matched++;
  }
 }
 if(seen!==want.positions.size)note(`${seen} stocked positions in the database, ${want.positions.size} in the files`);
 // Every source row imported exactly once, each stock row with one movement.
 for(const [planId,source]of want.rowsByPlan){
  const statuses=(await db.query('SELECT status,count(*)::int n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 GROUP BY status',[workspaceId,planId])).rows;
  const imported=statuses.find(s=>s.status==='IMPORTED')?.n||0,total=statuses.reduce((n,s)=>n+s.n,0);
  if(total!==source.rows||imported!==source.rows)note(`${planId}: ${source.rows} file rows, ${total} saved, ${imported} imported (${JSON.stringify(statuses)})`);
  if(source.stock){
   const links=(await db.query(`SELECT count(*) FILTER(WHERE jsonb_array_length(coalesce(movement_ids,'[]')::jsonb)<>1)::int wrong,
     count(*) FILTER(WHERE (parsed::jsonb->>'quantity')::numeric IS DISTINCT FROM quantity::numeric)::int stored_quantity_differs
    FROM import_rows WHERE workspace_id=$1 AND import_id=$2`,[workspaceId,planId])).rows[0];
   if(links.wrong)note(`${planId}: ${links.wrong} stock rows without exactly one stock movement`);
   if(links.stored_quantity_differs)note(`${planId}: ${links.stored_quantity_differs} rows record a different quantity in their import evidence than the file`);
  }
 }
 const moves=(await db.query(`SELECT count(*)::int n,count(DISTINCT reference)::int refs,coalesce(sum(quantity_delta),0)::text units FROM movements WHERE workspace_id=$1 AND operation='receive'`,[workspaceId])).rows[0];
 if(moves.n!==want.stockRows)note(`${moves.n} stock receipts, ${want.stockRows} stock rows in the files`);
 if(moves.refs!==moves.n)note(`${moves.n-moves.refs} duplicate stock receipts`);
 if(!same(moves.units,want.units))note(`receipts add ${moves.units} units, files add ${want.units}`);
 const ledger=(await db.query(`SELECT coalesce(sum(l.debit_minor),0)::text debit,coalesce(sum(l.credit_minor),0)::text credit,
   coalesce(sum(l.debit_minor-l.credit_minor) FILTER(WHERE a.system_key='INVENTORY_ASSET'),0)::text inventory
  FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id AND a.workspace_id=l.workspace_id
  JOIN accounting_journal_entries e ON e.id=l.entry_id AND e.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND e.status='POSTED'`,[workspaceId])).rows[0];
 if(ledger.debit!==ledger.credit)note(`ledger debits ${ledger.debit} and credits ${ledger.credit} differ`);
 if(BigInt(ledger.inventory)!==want.value)note(`inventory account ${ledger.inventory}, files value ${want.value}`);
 return {passed:problems.length===0,positions:want.positions.size,matchedPositions:matched,stockRows:want.stockRows,receipts:moves.n,units:want.units,valueMinor:want.value.toString(),
  ledgerBalanced:ledger.debit===ledger.credit,inventoryAccountMinor:ledger.inventory,problems};
}
module.exports={audit,expected};
