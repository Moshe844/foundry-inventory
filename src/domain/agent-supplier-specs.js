'use strict';

const {ValidationError}=require('./errors');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const aliases=new Map(Object.entries({
  barcode:['barcode',1],upc:['barcode',1],ean:['barcode',1],gtin:['barcode',1],
  weightgrams:['weight_grams',1],weightg:['weight_grams',1],weightkg:['weight_grams',1000],
  weightmg:['weight_grams',1,1000],weightlb:['weight_grams',45359237,100000],weightoz:['weight_grams',28349523125,1000000000],
  lengthmm:['length_mm',1],lengthcm:['length_mm',10],lengthin:['length_mm',254,10],
  widthmm:['width_mm',1],widthcm:['width_mm',10],widthin:['width_mm',254,10],
  heightmm:['height_mm',1],heightcm:['height_mm',10],heightin:['height_mm',254,10]
}));
const labels={barcode:'Barcode',weight_grams:'Weight (g)',length_mm:'Length (mm)',width_mm:'Width (mm)',height_mm:'Height (mm)'};

// Some imports preserve extra columns as catalog facts. Others retain the
// original cells on the imported row. Both representations identify the SKU.
const sourceFields=`WITH source_fields AS (
  SELECT f.sku_id,e.key,e.value FROM catalog_source_facts f
    CROSS JOIN LATERAL jsonb_each_text(coalesce(f.attributes,jsonb_build_object(coalesce(f.name,''),f.value))) e
    WHERE f.workspace_id=$1 AND f.source_import_id=$2
  UNION ALL
  SELECT r.sku_id,col->>'name',r.raw::jsonb->>((col->>'index')::int)
    FROM import_rows r JOIN import_plans p ON p.workspace_id=r.workspace_id AND p.id=r.import_id
    CROSS JOIN LATERAL jsonb_array_elements(p.source_columns::jsonb) col
    WHERE r.workspace_id=$1 AND r.import_id=$2 AND r.status='IMPORTED' AND r.sku_id IS NOT NULL
      AND jsonb_typeof(r.raw::jsonb)='array' AND col->>'index' ~ '^[0-9]+$'
)`;

function decode(field,raw){
  const value=String(raw??'').trim(),[key,numerator,denominator]=field;
  if(key==='barcode')return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)&&!/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(value)?value:null;
  if(!/^\d{1,10}(?:\.\d{1,6})?$/.test(value))return null;
  try{return require('./physical-measure').convert(value,{numerator,denominator});}
  catch(error){if(!(error instanceof ValidationError))throw error;return null;}
}

async function chosenSource(db,ctx,name){
  const value=String(name??'').trim();
  if(!value)throw new ValidationError('Choose the approved supplier file by its exact name or import ID.');
  const found=await db.query(`SELECT id,source_name FROM import_plans WHERE workspace_id=$1 AND (id=$2 OR lower(source_name)=lower($2))
    AND approval_status='APPROVED' AND status IN ('SUCCEEDED','PARTIAL') ORDER BY id LIMIT 2`,[ctx.workspaceId,value]);
  if(found.rowCount!==1)throw new ValidationError('Choose one completed, approved supplier file. Use the import ID if two files share a name.');
  return found.rows[0];
}

async function snapshot(db,ctx,args){
  const source=await chosenSource(db,ctx,args.sourceImport);
  const sku=String(args.sku??'').trim();
  const batch=Number(args.sourcePage??1);
  if(!Number.isSafeInteger(batch)||batch<1||batch>1000000)throw new ValidationError('Choose a valid supplier file page.');
  const {rows:items}=await db.query(`SELECT s.id,s.item_id,s.code,s.barcode,s.weight_grams,s.length_mm,s.width_mm,s.height_mm FROM skus s
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($3='' OR lower(s.code)=lower($3))
    AND (EXISTS(SELECT 1 FROM catalog_source_facts f WHERE f.workspace_id=s.workspace_id AND f.sku_id=s.id AND f.source_import_id=$2)
      OR EXISTS(SELECT 1 FROM import_rows r WHERE r.workspace_id=s.workspace_id AND r.sku_id=s.id AND r.import_id=$2 AND r.status='IMPORTED'))
    ORDER BY s.code,s.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,source.id,sku,(batch-1)*100]);
  const more=items.length>100;
  if(more)items.pop();
  const facts=await db.query(sourceFields+` SELECT * FROM source_fields WHERE sku_id=ANY($3::text[])`,
    [ctx.workspaceId,source.id,items.map(s=>s.id)]);
  const evidence=new Map();
  for(const fact of facts.rows){
    const field=aliases.get(fact.key.toLowerCase().replace(/[^a-z0-9]/g,''));
    if(!field || !String(fact.value??'').trim())continue;
    const key=JSON.stringify([fact.sku_id,field[0]]);
    if(!evidence.has(key))evidence.set(key,new Set());
    evidence.get(key).add(decode(field,fact.value));
  }
  const candidates=[],issues=[];
  for(const item of items){
    for(const key of Object.keys(labels)){
      if(item[key]!=null && String(item[key]).trim()!=='')continue;
      const values=evidence.get(JSON.stringify([item.id,key]));
      if(!values)continue;
      if(values.size!==1 || values.has(null)){issues.push({code:item.code,field:labels[key],reason:'Unclear or conflicting source values'});continue;}
      candidates.push({id:item.id,itemId:item.item_id,code:item.code,field:key,value:[...values][0]});
    }
  }
  const barcodes=candidates.filter(r=>r.field==='barcode').map(r=>String(r.value).toLowerCase());
  const collisions=barcodes.length?(await db.query(sourceFields+` SELECT lower(btrim(barcode)) AS value,id FROM skus
    WHERE workspace_id=$1 AND lower(btrim(barcode))=ANY($3::text[]) UNION
    SELECT lower(btrim(value)),sku_id FROM source_fields WHERE regexp_replace(lower(key),'[^a-z0-9]','','g') IN ('barcode','upc','ean','gtin')
      AND lower(btrim(value))=ANY($3::text[])`,[ctx.workspaceId,source.id,barcodes])).rows:[];
  const changes=candidates.filter(r=>{
    if(r.field!=='barcode'||!collisions.some(c=>c.id!==r.id&&c.value===r.value.toLowerCase()))return true;
    issues.push({code:r.code,field:labels.barcode,reason:'Barcode identifies another SKU'});return false;
  });
  return {source,sku,batch,more,changes,issues};
}

async function review(db,ctx,options){
  if(!options.filter)return {summary:'Enter the supplier file name or import ID to inspect its missing product specifications.',rows:[],more:false};
  const s=await snapshot(db,ctx,{sourceImport:options.filter,sourcePage:options.page});
  const rows=[...s.changes.map(r=>({SKU:r.code,Field:labels[r.field],Value:r.value,Status:'Ready',link:'/inventory/'+r.itemId})),
    ...s.issues.map(r=>({SKU:r.code,Field:r.field,Value:null,Status:r.reason}))];
  return {rows,more:s.more,summary:'Showing up to 100 SKUs per page from '+s.source.source_name+'. Only empty fields with unambiguous values can be filled.'};
}

async function build(db,ctx,_text,args){
  const s=await snapshot(db,ctx,args);
  if(!s.changes.length)throw new ValidationError('No missing product specifications can be filled safely from this supplier file.');
  return {payload:{sourceImport:s.source.id,sourcePage:s.batch,sku:s.sku,fingerprint:hash(s.changes),changes:s.changes},
    summary:'Fill '+s.changes.length+' missing product fields from '+s.source.source_name+'. '+s.issues.length+' uncertain fields will stay open.'};
}

async function execute(client,ctx,p){
  await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,[...new Set(p.changes.map(r=>r.id))]]);
  const s=await snapshot(client,ctx,p);
  if(p.fingerprint!==hash(s.changes)||p.fingerprint!==hash(p.changes))throw new ValidationError('The supplier data or catalog changed. Review the proposed fixes again.');
  const ids=[];
  for(const r of s.changes){
    // Field names come from the fixed alias map, never from the imported header.
    const result=await client.query('UPDATE skus SET '+r.field+'=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,r.value]);
    if(result.rowCount!==1)throw new ValidationError('The selected product is unavailable.');
    const id=newId('spec');
    await client.query(`INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,'fill_supplier_spec','{}',$6)`,[id,ctx.workspaceId,ctx.actorId,r.itemId,r.id,{sourceImport:s.source.id,field:r.field,value:r.value}]);
    ids.push(id);
  }
  return {ids,fields:ids.length};
}

async function verify(db,ctx,r,p){
  const {rows}=await db.query(`SELECT h.sku_id,h.after_state,to_jsonb(s)->>(h.after_state->>'field') AS stored
    FROM catalogue_change_history h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
    WHERE h.workspace_id=$1 AND h.id=ANY($2::text[]) AND h.action='fill_supplier_spec'`,[ctx.workspaceId,r.ids]);
  return rows.length===p.changes.length&&rows.every(row=>row.stored===String(row.after_state.value)&&row.after_state.sourceImport===p.sourceImport);
}

module.exports={review,build,execute,verify,labels,aliases,decode};
