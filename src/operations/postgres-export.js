'use strict';
const XLSX=require('xlsx'),sourceDetails=require('../domain/postgres-catalog-facts');
const tables=require('./postgres-export-tables');
async function workbook(database,workspaceId,{itemIds=null}={}){
 const source=await database.transaction(async client=>{
  const workspace=(await client.query('SELECT name FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
  const inventory=(await client.query(`SELECT i.name AS "Product",i.base_code AS "Item code",s.code AS "SKU",s.variant_label AS "Variant",i.unit_label AS "Unit",l.name AS "Location",COALESCE(b.on_hand,0) AS "On hand",COALESCE(c.quantity_units,0) AS "Units with recorded cost",c.total_cost_minor AS value_minor,a.base_currency AS book_currency,p.amount_minor AS price_minor,p.currency AS price_currency,
    (SELECT string_agg(sp.name,', ' ORDER BY sp.name) FROM supplier_items si JOIN suppliers sp ON sp.workspace_id=si.workspace_id AND sp.id=si.supplier_id WHERE si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.is_active=1) AS "Suppliers"
    FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id
    LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id LEFT JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
    LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
    LEFT JOIN accounting_settings a ON a.workspace_id=i.workspace_id
    LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
    WHERE i.workspace_id=$1 AND ($2::text[] IS NULL OR i.id=ANY($2::text[])) ORDER BY i.name,s.position,s.code,l.name`,[workspaceId,itemIds])).rows.map(r=>{
      const {value_minor,book_currency,price_minor,price_currency,...row}=r,currency=require('../domain/currency');
      return {...row,'On hand':Number(row['On hand']),'Units with recorded cost':Number(row['Units with recorded cost']),'Selling price':price_minor==null?null:currency.fromMinor(price_minor,price_currency),'Price currency':price_currency,'Inventory book value':value_minor==null?null:currency.fromMinor(value_minor,book_currency),'Book currency':book_currency};
    });
  const sheets=[{name:'Inventory',rows:inventory}];
  if(itemIds){
    const selections=[['Products','SELECT i.* FROM items i WHERE i.workspace_id=$1 AND i.id=ANY($2::text[])'],['SKUs and variants','SELECT s.* FROM skus s WHERE s.workspace_id=$1 AND s.item_id=ANY($2::text[])'],['Stock by location','SELECT b.* FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id WHERE b.workspace_id=$1 AND s.item_id=ANY($2::text[])'],['Stock movements','SELECT m.* FROM movements m WHERE m.workspace_id=$1 AND m.item_id=ANY($2::text[])'],['Imported source details','SELECT f.* FROM catalog_source_facts f JOIN skus s ON s.workspace_id=f.workspace_id AND s.id=f.sku_id WHERE f.workspace_id=$1 AND s.item_id=ANY($2::text[])']];
    for(const [name,sql]of selections)sheets.push({name,rows:name==='Imported source details'?await sourceDetails.exportRows(client,workspaceId,{itemIds}):(await client.query(sql,[workspaceId,itemIds])).rows});
  }else for(const [name,table]of tables){const rows=table==='catalog_source_facts'?await sourceDetails.exportRows(client,workspaceId):(await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows;sheets.push({name,rows});}
  return {name:workspace?.name||'StockChief inventory',sheets};
 },{isolation:'REPEATABLE READ',readOnly:true});
 const book=XLSX.utils.book_new(),summary=[['StockChief inventory export'],['Inventory',source.name],['Exported at (UTC)',new Date().toISOString()],['Money','Amounts ending in minor are exact minor currency units. Keep each record’s currency.'],['Dates','Timestamps are UTC instants; calendar dates retain their original dates.'],['Data','All rows from one consistent snapshot; no 100/200-row display limits.'],[],['Sheet','Records']];
 for(const sheet of source.sheets){summary.push([sheet.name,sheet.rows.length]);for(let offset=0,part=1;offset<Math.max(1,sheet.rows.length);offset+=100000,part++){
   const rows=sheet.rows.slice(offset,offset+100000).map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v instanceof Date?v.toISOString():v&&typeof v==='object'?JSON.stringify(v):v])));
   XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),sheet.name+(part>1?' '+part:''));
  }}
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(summary),'Read me');
 book.SheetNames=['Read me',...book.SheetNames.filter(n=>n!=='Read me')];
 return {name:source.name,buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true}),counts:Object.fromEntries(source.sheets.map(s=>[s.name,s.rows.length]))};
}
module.exports={workbook,tables};
