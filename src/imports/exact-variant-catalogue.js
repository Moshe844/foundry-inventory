'use strict';

const {hash}=require('../pricing/postgres-promotions');
const {codeKey}=require('../domain/catalog-identity');
const {normalized}=require('./exact-variant-source');
const skuKey=codeKey;
const axisKey=name=>normalized(name).replace(/^colou?rs?$/u,'color').replace(/^sizes$/u,'size');
const optionKey=options=>JSON.stringify(options.map(p=>[axisKey(p.name),normalized(p.value)]).sort(([a],[b])=>a.localeCompare(b)));
const axesKey=options=>JSON.stringify(options.map(p=>axisKey(p.name)).sort());

function collect(rows,key){
  const groups=new Map();
  for(const row of rows){
    const k=key(row),list=groups.get(k)||[];
    list.push(row);
    groups.set(k,list);
  }
  return groups;
}

async function nativeCatalogue(db,workspaceId,candidates){
  const distinct=values=>[...new Set(values.filter(Boolean).map(codeKey))];
  const parents=distinct(candidates.map(r=>r.parent)),names=distinct(candidates.map(r=>r.name)),codes=distinct(candidates.map(r=>r.sku)),
    barcodes=distinct(candidates.map(r=>r.barcode));
  const items=(await db.query(`SELECT i.id,i.name,i.base_code,i.unit_label,i.tracking_mode,i.is_active,i.has_variants,
    i.quantity_precision,i.quantity_increment::text,i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text
    FROM items i WHERE i.workspace_id=$1 AND (lower(btrim(i.base_code))=ANY($2::text[]) OR lower(btrim(i.name))=ANY($3::text[]) OR i.id IN(
      SELECT s.item_id FROM skus s WHERE s.workspace_id=$1 AND lower(btrim(s.code))=ANY($4::text[])))
    ORDER BY i.id FOR SHARE OF i`,[workspaceId,parents,names,codes])).rows;
  const skus=(await db.query(`SELECT s.id,s.item_id,s.code,s.barcode,s.is_active,s.is_default FROM skus s
    WHERE s.workspace_id=$1 AND (s.item_id=ANY($2::text[]) OR lower(btrim(s.code))=ANY($3::text[]) OR lower(btrim(s.barcode))=ANY($4::text[]))
    ORDER BY s.id FOR SHARE OF s`,[workspaceId,items.map(p=>p.id),codes,barcodes])).rows;
  const nativeAxes=(await db.query(`SELECT id,item_id,name FROM item_options WHERE workspace_id=$1 AND item_id=ANY($2::text[])
    ORDER BY item_id,position,id FOR SHARE`,[workspaceId,items.map(p=>p.id)])).rows;
  const values=(await db.query(`SELECT v.sku_id,o.name,v.value FROM sku_option_values v JOIN item_options o ON o.id=v.option_id
    WHERE o.workspace_id=$1 AND v.sku_id=ANY($2::text[]) ORDER BY v.sku_id,o.position,o.id FOR SHARE OF v`,
    [workspaceId,skus.map(s=>s.id)])).rows;
  const axes=collect(nativeAxes,p=>p.item_id),parts=collect(values,p=>p.sku_id);
  for(const item of items)item.axes=axes.get(item.id)||[];
  for(const sku of skus)sku.options=(parts.get(sku.id)||[]).map(p=>({name:p.name,value:p.value}));
  return {items,skus};
}

function chosenParent(group,inventory,indexes){
  const parent=group[0].parent,name=group.find(r=>r.name)?.name||'';
  const mentionedNames=[...new Set(group.map(r=>r.name).filter(Boolean).map(codeKey))];
  if(mentionedNames.length>1)return {problem:'The same source product has different names.'};
  const linked=[...new Set(group.flatMap(r=>(indexes.byCode.get(skuKey(r.sku))||[]).map(s=>s.item_id)))];
  if(linked.length>1)return {problem:'The supplied SKUs already belong to different recorded products.'};
  if(parent){
    const matches=indexes.byParent.get(codeKey(parent))||[];
    if(matches.length>1)return {problem:'This product code matches several inventory records.'};
    if(linked.length&&(!matches.length||linked[0]!==matches[0].id))return {problem:'The source product code disagrees with the recorded parent of this SKU.'};
    if(!matches.length&&!name)return {problem:'Give the exact name of this new product in the source or its product worksheet.'};
    return {item:matches[0]||null,name,baseCode:parent};
  }
  if(linked.length)return {item:inventory.items.find(i=>i.id===linked[0]),name,baseCode:null};
  if(!name)return {problem:'This new SKU needs a source product code and name, or an exact product name.'};
  const matches=indexes.byName.get(codeKey(name))||[];
  if(matches.length>1)return {problem:'Several saved products share this name. Supply the exact product code.'};
  return {item:matches[0]||null,name,baseCode:null,ownerMatch:Boolean(matches.length)};
}

function validGroup(group,parent){
  if(parent.problem)return parent.problem;
  if(parent.item&&!Number(parent.item.is_active))return 'The exact product is archived. Restore it in the catalogue before importing variants.';
  if(parent.item&&parent.name&&codeKey(parent.item.name)!==codeKey(parent.name))return 'The recorded product name differs from the supplied parent. Check the original product code.';
  const axisSets=new Set(group.filter(r=>!r.errors.length).map(r=>axesKey(r.options)));
  if(axisSets.size>1)return 'Rows for one product must identify the same option names.';
  if(parent.item?.axes.length&&axisSets.size&&axesKey(parent.item.axes)!==[...axisSets][0])
    return 'The supplied option names differ from this product’s recorded variant options.';
  return null;
}

async function inspect(db,ctx,candidates,sourceIssues=[]){
  const catalogue=await nativeCatalogue(db,ctx.workspaceId,candidates);
  const problems=[...sourceIssues],byCode=collect(catalogue.skus,s=>skuKey(s.code)),
    byItem=collect(catalogue.skus,s=>s.item_id),byBarcode=collect(catalogue.skus.filter(s=>s.barcode),s=>codeKey(s.barcode));
  const indexes={byCode,byParent:collect(catalogue.items,p=>codeKey(p.base_code)),byName:collect(catalogue.items,p=>codeKey(p.name))};
  const groupKey=r=>r.parent?'parent:'+codeKey(r.parent):r.name?'name:'+codeKey(r.name):
    byCode.get(skuKey(r.sku))?.length===1?'item:'+byCode.get(skuKey(r.sku))[0].item_id:'row:'+r.sheet+':'+r.row;
  const groups=collect(candidates,groupKey),planned=new Map(),rows=[],seenCodes=new Map(),seenOptions=new Map(),seenBarcodes=new Map(),targetAxes=new Map();
  const note=(row,message,reviewable=false)=>problems.push({sheet:row.sheet,row:row.row,part:row.part,message,reviewable});
  for(const [key,group] of groups){
    const parent=chosenParent(group,catalogue,indexes);let groupIssue=validGroup(group,parent);
    const first=group[0],item=parent.item||null;
    if(parent.ownerMatch&&!groupIssue)note(first,'Check the recorded product match. The source gives its name without its product code.',true);
    const targetKey=item?'item:'+item.id:key,choices=collect(byItem.get(item?.id)||[],s=>optionKey(s.options));
    const initialAxes=item?.axes.length?item.axes:group.find(r=>!r.errors.length)?.options||[];
    const axes=targetAxes.get(targetKey)||initialAxes;
    if(!groupIssue&&axes.length&&initialAxes.length&&axesKey(axes)!==axesKey(initialAxes))
      groupIssue='All source rows for the same recorded product need the same option names.';
    if(!groupIssue&&initialAxes.length&&!targetAxes.has(targetKey))targetAxes.set(targetKey,initialAxes);
    const name=item?.name||parent.name||first.name,baseCode=item?.base_code||parent.baseCode||null;
    for(const source of group){
      const row={...source,preview:{action:'create',itemId:item?.id||null,skuId:null,product:name||'',productCode:baseCode}};
      const errors=[...source.errors,...(groupIssue?[groupIssue]:[])],sourceSku=skuKey(source.sku),signature=optionKey(source.options);
      const found=byCode.get(sourceSku)||[];
      const matchingOptions=choices.get(signature)||[];
      if(found.length>1)errors.push('This exact SKU is ambiguous in the catalogue.');
      if(found.length===1){
        const current=found[0];
        if(current.item_id!==item?.id||!Number(current.is_active)||optionKey(current.options)!==signature||
          source.barcode&&codeKey(source.barcode)!==codeKey(current.barcode))
          errors.push('The saved SKU has different options, a different parent or barcode, or is archived.');
        else{row.preview.action='existing';row.preview.skuId=current.id;}
      }else if(matchingOptions.length)errors.push('This option combination already has a different recorded SKU.');
      const previous=seenCodes.get(sourceSku);
      const exact=JSON.stringify([targetKey,signature,codeKey(source.barcode)]);
      if(previous&&previous!==exact)errors.push('The same SKU appears with different parent, options or barcode.');
      else if(previous&&row.preview.action==='create')row.preview.action='repeat';
      if(sourceSku&&!previous)seenCodes.set(sourceSku,exact);
      const combo=targetKey+':'+signature,previousSku=seenOptions.get(combo);
      if(previousSku&&previousSku!==sourceSku)errors.push('One option combination has more than one source SKU.');
      else if(sourceSku)seenOptions.set(combo,sourceSku);
      if(source.barcode){
        const b=codeKey(source.barcode),used=byBarcode.get(b)||[];
        if(used.some(s=>skuKey(s.code)!==sourceSku)||seenBarcodes.has(b)&&seenBarcodes.get(b)!==sourceSku)
          errors.push('This barcode already identifies another variant.');
        else seenBarcodes.set(b,sourceSku);
      }
      if(errors.length){
        row.preview.action='review';
        row.preview.errors=[...new Set(errors)];
        for(const message of row.preview.errors)note(row,message);
      }else if(row.preview.action==='create'){
        const definition=planned.get(targetKey)||{name,baseCode,unitLabel:item?.unit_label||'unit',trackingMode:item?.tracking_mode||'quantity',
          appendToItemId:item?.id||null,variants:[]};
        const ordered=axes.map(axis=>{
          const p=source.options.find(v=>axisKey(v.name)===axisKey(axis.name));
          return {name:axis.name,value:p.value};
        });
        definition.variants.push({key:sourceSku,code:source.sku,barcode:source.barcode||null,options:ordered});
        planned.set(targetKey,definition);
      }
      rows.push(row);
    }
  }
  const definitions=[...planned.values()],states={create:0,existing:0,repeat:0,review:0};
  for(const row of rows)states[row.preview.action]++;
  const itemIds=new Set(rows.map(r=>r.preview.itemId)),skuIds=new Set(rows.map(r=>r.preview.skuId));
  const current={items:catalogue.items.filter(i=>itemIds.has(i.id)),skus:catalogue.skus.filter(s=>skuIds.has(s.id))};
  const blocking=problems.filter(p=>!p.reviewable).length;
  const summary={...states,sourceRows:candidates.length,products:definitions.filter(d=>!d.appendToItemId).length,
    existingProducts:definitions.filter(d=>d.appendToItemId).length,blocking,notes:problems.length-blocking};
  const identity=hash([candidates,problems,definitions,rows.map(r=>r.preview),current]);
  return {rows,problems,summary,definitions,identity,writeHash:hash(definitions)};
}

module.exports={inspect};
