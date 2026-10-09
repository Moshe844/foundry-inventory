'use strict';

const crypto = require('node:crypto');
const parser = require('./parser');
const mappingService = require('./mapping-service');
const fields = require('./fields');
const supplierDataset=require('./supplier-dataset');
const commerce=require('../operations/postgres-commerce');
const rowValues = require('./row-validator');
const catalog = require('../domain/postgres-catalog-service');
const inventory = require('../domain/postgres-inventory-engine');
const ledger = require('../accounting/postgres-ledger');
const costing = require('../accounting/postgres-costing');
const prices = require('../pricing/price-service');
const postgresPrices = require('../pricing/postgres-service');
const permissions = require('../actions/permissions');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');

const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

function json(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
}

function hydratePlan(row) {
  if (!row) return null;
  return {
    id:row.id, workspaceId:row.workspace_id, createdByUserId:row.created_by_user_id,
    approvedByUserId:row.approved_by_user_id, sourceName:row.source_name, sourceKind:row.source_kind,
    sourceHash:row.source_hash, sourceBytes:Number(row.source_bytes), detectedType:row.detected_type,
    sheetName:row.sheet_name, sheetIndex:Number(row.sheet_index), sourceColumns:json(row.source_columns,[]),
    fieldMappings:json(row.field_mappings,{}), transformations:json(row.transformations,{}),
    trackingModel:json(row.tracking_model,{}), locationMappings:json(row.location_mappings,{}),
    defaultLocationId:row.default_location_id, recordsDetected:Number(row.records_detected),
    recordsValid:Number(row.records_valid), recordsInvalid:Number(row.records_invalid),
    warnings:json(row.warnings,[]), conflicts:json(row.conflicts,[]), assumptions:json(row.assumptions,[]),
    approvalStatus:row.approval_status, status:row.status, planVersion:Number(row.plan_version),
    integrityHash:row.integrity_hash, createdAt:row.created_at, approvedAt:row.approved_at,
    completedAt:row.completed_at, isExpired:Date.parse(row.created_at) + PLAN_TTL_MS < Date.now(),
  };
}

function hydrateRow(row) {
  return {
    id:row.id, importId:row.import_id, rowNumber:Number(row.row_number), raw:json(row.raw,[]),
    parsed:json(row.parsed,{}), status:row.status, problems:json(row.problems,[]),
    itemId:row.item_id, skuId:row.sku_id, locationId:row.location_id,
    movementIds:json(row.movement_ids,[]), quantity:row.quantity === null ? null : Number(row.quantity),
    importedAt:row.imported_at,
  };
}

function textCell(row, index) {
  return index === undefined ? '' : String(row.cells[index] ?? '').trim();
}

function problem(code, message) {
  return { code, message };
}

async function workspaceContext(database, workspaceId) {
  const [locations, skus, accounting] = await Promise.all([
    database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id`,[workspaceId]),
    database.query(`SELECT s.id,s.code,s.item_id,i.name,i.tracking_mode FROM skus s
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1`,[workspaceId]),
    database.query(`SELECT enabled,base_currency FROM accounting_settings WHERE workspace_id=$1`,[workspaceId]),
  ]);
  const locationByName = new Map();
  for (const row of locations.rows) {
    const key=row.name.toLowerCase();
    const matches=locationByName.get(key) || [];
    matches.push(row);locationByName.set(key,matches);
  }
  const skuByCode = new Map();
  for (const row of skus.rows) {
    const key=row.code.toLowerCase();
    const matches=skuByCode.get(key) || [];
    matches.push(row);skuByCode.set(key,matches);
  }
  return { locations:locations.rows,locationByName,skuByCode,
    accountingReady:Number(accounting.rows[0]?.enabled)===1,
    accountingCurrency:accounting.rows[0]?.base_currency||null };
}

function validateRows(sheet, mappings, proposal, context, input = {}) {
  const rows=[];
  const unknownLocations=new Map();
  const defaultLocation=context.locations.find((row)=>row.id===input.defaultLocationId) ||
    (context.locations.length===1 ? context.locations[0] : null);
  for (const [position,row] of sheet.rows.entries()) {
    const problems=[];
    const code=trimOrNull(textCell(row,mappings.code));
    const name=trimOrNull(textCell(row,mappings.name)) || code;
    const quantitySource=Object.hasOwn(input.quantityOverrides||{},row.sourceRow)
      ?input.quantityOverrides[row.sourceRow]:textCell(row,mappings.quantity);
    const quantityRead=rowValues.readQuantity(quantitySource);
    let quantity=quantityRead.ok ? quantityRead.value : null;
    if(!quantityRead.ok)problems.push(problem(quantityRead.problem,'Quantity must be a whole number of zero or more.'));
    const costText=trimOrNull(textCell(row,mappings.unitCost));
    const sellingText=trimOrNull(textCell(row,mappings.sellingPrice));
    let sellingPriceMinor=null;
    if(sellingText){try{sellingPriceMinor=prices.toMinor(sellingText,'Selling price');}
      catch{problems.push(problem('bad_selling_price','Selling price must be a non-negative money amount.'));}}
    let unitCostMinor=null;
    if(costText){try{unitCostMinor=prices.toMinor(costText,'Unit cost');}
      catch{problems.push(problem('bad_unit_cost','Unit cost must be a non-negative money amount.'));}}
    if(unitCostMinor!==null&&!(quantity>0))
      problems.push(problem('cost_without_stock','Unit cost cannot be recorded without a positive opening stock quantity. No cost will be silently discarded.'));
    const currency=(trimOrNull(textCell(row,mappings.currency))||context.accountingCurrency||'USD').toUpperCase();
    if(unitCostMinor!==null&&quantity>0&&!context.accountingReady)
      problems.push(problem('accounting_not_ready','Configure accounting before importing valued opening stock.'));
    if(unitCostMinor!==null&&quantity>0&&context.accountingCurrency&&currency!==context.accountingCurrency)
      problems.push(problem('cost_currency_mismatch','The source cost currency differs from the inventory accounting currency.'));
    if(unitCostMinor!==null&&quantity>0&&!Number.isSafeInteger(unitCostMinor*quantity))
      problems.push(problem('cost_overflow','This row’s total inventory cost exceeds the supported range.'));
    const locationText=trimOrNull(textCell(row,mappings.location));
    let location=defaultLocation;
    if(locationText){
      const mapped=context.locations.find((candidate)=>candidate.id===input.locationMappings?.[locationText]);
      const matches=context.locationByName.get(locationText.toLowerCase()) || [];
      if(mapped)location=mapped;
      else if(matches.length===1)location=matches[0];
      else {
        location=null;
        unknownLocations.set(locationText,(unknownLocations.get(locationText) || 0)+1);
        problems.push(problem('unknown_location',matches.length?'More than one location has this name.':'This location does not exist in this inventory.'));
      }
    }
    if(!name)problems.push(problem('no_product','A product name or SKU is required.'));
    if(quantity !== null && quantity > 0 && !location)problems.push(problem('no_location','Choose where this opening stock is held.'));
    const variants=fields.VARIANT_FIELDS.map((field)=>({name:proposal.axisNames[field] || fields.FIELD_LABEL[field],
      value:trimOrNull(textCell(row,mappings[field]))})).filter((entry)=>entry.value);
    const serial=trimOrNull(textCell(row,mappings.serial));
    const lotCode=trimOrNull(textCell(row,mappings.lotCode));
    if(proposal.detectedType==='serials'){
      if(!serial)problems.push(problem('missing_serial','A serial number is required for this row.'));
      if(quantity === null)quantity=1;
      if(quantity !== 1)problems.push(problem('serial_quantity','Each serial-number row must represent exactly one unit.'));
    }
    if(proposal.detectedType==='lots' && quantity > 0 && !lotCode)problems.push(problem('missing_lot','A lot or batch number is required.'));
    const existingMatches=code ? (context.skuByCode.get(code.toLowerCase()) || []) : [];
    if(existingMatches.length>1)problems.push(problem('ambiguous_existing_code','This SKU code matches more than one active record.'));
    const blocking=new Set(['bad_quantity','negative_quantity','fractional_quantity','bad_unit_cost','cost_without_stock','bad_selling_price',
      'accounting_not_ready','cost_currency_mismatch','cost_overflow','no_product','unknown_location','no_location',
      'missing_serial','serial_quantity','missing_lot','ambiguous_existing_code']);
    const parsed={name,code,description:trimOrNull(textCell(row,mappings.description)),
      unitLabel:trimOrNull(textCell(row,mappings.unitLabel)) || 'unit',barcode:trimOrNull(textCell(row,mappings.barcode)),
      unitCostMinor,sellingPriceMinor,currency,
      quantity,variants,locationId:location?.id || null,locationName:location?.name || null,locationText,
      serial,lotCode,expiresAt:trimOrNull(textCell(row,mappings.expiresAt)),
      receivedAt:trimOrNull(textCell(row,mappings.receivedAt)),notes:trimOrNull(textCell(row,mappings.notes)),
      trackingMode:proposal.detectedType==='serials'?'serial':proposal.detectedType==='lots'?'lot':'quantity',
      existingSkuId:existingMatches.length===1?existingMatches[0].id:null,
      existingItemId:existingMatches.length===1?existingMatches[0].item_id:null};
    const blocked=problems.some((entry)=>blocking.has(entry.code));
    rows.push({id:newId('improw'),rowNumber:row.sourceRow,position,raw:row.cells,parsed,problems,
      status:blocked?'INVALID':'VALID'});
  }
  return { rows,summary:{total:rows.length,valid:rows.filter((row)=>row.status==='VALID').length,
    invalid:rows.filter((row)=>row.status==='INVALID').length,
    units:rows.filter((row)=>row.status==='VALID').reduce((sum,row)=>sum+(row.parsed.quantity || 0),0),
    unvaluedUnits:rows.filter((row)=>row.status==='VALID'&&row.parsed.unitCostMinor===null)
      .reduce((sum,row)=>sum+(row.parsed.quantity||0),0),
    valuedMinor:rows.filter((row)=>row.status==='VALID'&&row.parsed.unitCostMinor!==null)
      .reduce((sum,row)=>sum+(row.parsed.quantity||0)*row.parsed.unitCostMinor,0)},
    conflicts:[...unknownLocations].map(([text,count])=>({kind:'unknown_location',text,count})),
    defaultLocationId:defaultLocation?.id || null };
}

function unmappedNumericColumns(sheet,mappings){
  if(mappings.quantity!==undefined)return [];
  const claimed=new Set(Object.values(mappings));
  return sheet.columns.filter((column)=>!claimed.has(column.index)&&
    (()=>{const profile=fields.profileColumn(sheet.rows,column.index);
      return profile.filled>0&&profile.numericRate>=0.8;})()).map((column)=>column.name);
}

function previewWarnings(summary,{hasQuantity=true,hasIdentity=true,unmappedNumeric=[]}={}) {
  const warnings=[];
  if(!hasIdentity)warnings.push('StockChief could not safely identify which column names each product. Map a product name or SKU below, then recalculate the preview. Nothing can be imported until you do.');
  if(summary.invalid)warnings.push(`${summary.invalid} row(s) need correction before they can be imported.`);
  if(summary.unvaluedUnits)warnings.push(`${summary.unvaluedUnits} opening unit(s) have no source unit cost. StockChief will retain their quantity but cannot certify their inventory value until cost evidence is supplied.`);
  if(!hasQuantity)warnings.push('No quantity column is mapped. This preview would create or match products without establishing opening stock.');
  if(unmappedNumeric.length)warnings.push(`Unmapped numeric column${unmappedNumeric.length===1?'':'s'}: ${unmappedNumeric.join(', ')}. Map any stock quantity before approval, or explicitly confirm this is catalog-only data.`);
  return warnings;
}

function integrityFor(plan, rows) {
  return digest({sourceHash:plan.sourceHash,detectedType:plan.detectedType,fieldMappings:plan.fieldMappings,
    defaultLocationId:plan.defaultLocationId,rows:rows.map((row)=>({rowNumber:row.rowNumber,parsed:row.parsed,status:row.status}))});
}

async function assertOperator(database, ctx) {
  const result=await database.query('SELECT role,permissions FROM users WHERE id=$1 AND workspace_id=$2',[ctx.actorId,ctx.workspaceId]);
  if(!result.rows.length)throw new ValidationError('The acting user does not belong to this inventory.');
  permissions.assertCan(result.rows[0],permissions.OPERATE,'import inventory data');
}

async function supplierRows(database,ctx,sheet,mappings){
  const actor=(await database.query('SELECT role,permissions FROM users WHERE id=$1 AND workspace_id=$2',
    [ctx.actorId,ctx.workspaceId])).rows[0];
  permissions.assertCan(actor,permissions.MANAGE_SUPPLIERS,'import suppliers');
  const existing=(await database.query('SELECT name FROM suppliers WHERE workspace_id=$1',[ctx.workspaceId])).rows;
  return supplierDataset.validate(sheet,mappings,existing.map((row)=>row.name));
}

async function saveSupplierPreview(database,ctx,{bytes,sourceHash,filename,sheet,sheetIndex=0,format,mappings}){
  const rows=await supplierRows(database,ctx,sheet,mappings);
  const at=nowIso();const valid=rows.filter((row)=>row.status==='VALID').length;
  const plan={id:newId('imp'),workspaceId:ctx.workspaceId,createdByUserId:ctx.actorId,
    sourceName:filename||'Pasted supplier data',sourceKind:format==='xlsx'?'xlsx':format==='pdf'?'pdf':
      format==='image'?'image':filename?'csv':'paste',sourceHash,sourceBytes:bytes.length,
    detectedType:'unknown',sheetName:sheet.name,sheetIndex,
    sourceColumns:sheet.columns.map((column)=>({index:column.index,name:column.name})),
    fieldMappings:mappings,transformations:{dataset:'suppliers'},trackingModel:{mode:'per-row'},
    locationMappings:{},defaultLocationId:null,recordsDetected:rows.length,recordsValid:valid,
    recordsInvalid:rows.length-valid,warnings:valid<rows.length
      ?[`${rows.length-valid} supplier row(s) need correction or already exist and will not be created.`]:[],
    conflicts:[],assumptions:[],approvalStatus:'AWAITING_APPROVAL',status:'READY',planVersion:1,createdAt:at};
  plan.integrityHash=integrityFor(plan,rows);
  await database.transaction(async(client)=>{
    await client.query(`INSERT INTO import_plans(id,workspace_id,created_by_user_id,source_name,source_kind,source_hash,
      source_bytes,detected_type,sheet_name,sheet_index,source_columns,field_mappings,transformations,tracking_model,
      location_mappings,default_location_id,records_detected,records_valid,records_invalid,warnings,conflicts,assumptions,
      approval_status,status,plan_version,integrity_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [plan.id,ctx.workspaceId,ctx.actorId,plan.sourceName,plan.sourceKind,plan.sourceHash,plan.sourceBytes,
      plan.detectedType,plan.sheetName,plan.sheetIndex,JSON.stringify(plan.sourceColumns),JSON.stringify(mappings),
      JSON.stringify(plan.transformations),JSON.stringify(plan.trackingModel),'{}',null,plan.recordsDetected,
      valid,plan.recordsInvalid,JSON.stringify(plan.warnings),'[]','[]',plan.approvalStatus,plan.status,1,plan.integrityHash,at]);
    for(const row of rows)await client.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,parsed,
      status,problems,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.id,plan.id,ctx.workspaceId,row.rowNumber,JSON.stringify(row.raw),JSON.stringify(row.parsed),row.status,
      JSON.stringify(row.problems),at]);
  },{isolation:'SERIALIZABLE'});
  return get(database,ctx.workspaceId,plan.id);
}

async function analyse(database, ctx, input) {
  await assertOperator(database,ctx);
  const buffer=input.buffer || null;
  const text=input.text === undefined ? null : String(input.text);
  if(!buffer && !String(text || '').trim())throw new ValidationError('Choose a file, or paste your data.');
  const bytes=buffer || Buffer.from(text,'utf8');
  const sourceHash=digest(bytes);
  const isPdf=Boolean(buffer)&&buffer.subarray(0,5).toString('ascii')==='%PDF-';
  const isImage=Boolean(buffer)&&Boolean(require('./image-table').dimensions(buffer));
  const parsedWorkbook=isPdf?await require('./pdf-table').parse(buffer):
    isImage?await require('./image-table').parse(buffer):
      parser.parse(buffer?{buffer,filename:input.filename}:{text,filename:input.filename});
  const sheetIndex=Number.isInteger(input.sheetIndex)?input.sheetIndex:parsedWorkbook.primarySheet;
  const sheet=parsedWorkbook.sheets[sheetIndex];
  if(!sheet?.rows.length)throw new ValidationError('That source has no inventory rows.');
  const supplierMapping=supplierDataset.classify(sheet.columns);
  if(supplierMapping)return saveSupplierPreview(database,ctx,{bytes,sourceHash,filename:input.filename,
    sheet,sheetIndex,format:parsedWorkbook.format,mappings:supplierMapping});
  const prior=(await database.query(`SELECT field_mappings,detected_type FROM import_plans
    WHERE workspace_id=$1 AND source_hash=$2 AND approval_status='APPROVED' AND status<>'CANCELLED'
    ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ctx.workspaceId,sourceHash])).rows[0];
  const modelProvider=input.provider||(require('../config').ai.configured?
    require('../ai/provider').createProviderUnobserved(require('../config').ai.provider,require('../config').ai.tier('fast')):null);
  const proposal=await mappingService.proposeMappings({...sheet,sourceName:input.filename || 'pasted data'},
    {provider:modelProvider?require('../commercial/model').wrap(database,ctx,modelProvider,'import_mapping',input.usageKey||require('./usage-key').analysisUsageKey(sourceHash)):null,
      mappings:input.mappings || json(prior?.field_mappings,null),detectedType:input.detectedType || prior?.detected_type,
      onBeforeAi:input.onBeforeAi,onUsage:input.onUsage});
  // An uncertain interpretation is a review task, not an upload failure. Keep
  // the source columns and rows in an unapproved preview so the operator can
  // identify the product column without editing and re-uploading the file.
  const context=await workspaceContext(database,ctx.workspaceId);
  if(input.defaultLocationId && !context.locations.some((row)=>row.id===input.defaultLocationId))
    throw new ValidationError('That destination location is not in this inventory.');
  const validated=validateRows(sheet,proposal.mappings,proposal,context,input);
  const unmappedNumeric=unmappedNumericColumns(sheet,proposal.mappings);
  const at=nowIso();
  const plan={id:newId('imp'),workspaceId:ctx.workspaceId,createdByUserId:ctx.actorId,
    sourceName:input.filename || 'Pasted inventory data',sourceKind:buffer?parsedWorkbook.format==='pdf'
      ?'pdf':parsedWorkbook.format==='image'?'image':parsedWorkbook.format==='xlsx'?'xlsx':'csv':'paste',
    sourceHash,sourceBytes:bytes.length,detectedType:proposal.detectedType,sheetName:sheet.name,
    sheetIndex,sourceColumns:sheet.columns.map((column)=>({index:column.index,name:column.name})),
    fieldMappings:proposal.mappings,transformations:{axisNames:proposal.axisNames,aiUsed:proposal.aiUsed,
      ignoredColumns:proposal.ignoredColumns,sheetCount:parsedWorkbook.sheets.length,
      unmappedNumericColumns:unmappedNumeric,confirmCatalogOnly:false},trackingModel:{mode:'per-row'},
    locationMappings:{},defaultLocationId:validated.defaultLocationId,recordsDetected:validated.summary.total,
    recordsValid:validated.summary.valid,recordsInvalid:validated.summary.invalid,
    warnings:previewWarnings(validated.summary,{hasQuantity:proposal.mappings.quantity!==undefined,
      hasIdentity:proposal.mappings.name!==undefined||proposal.mappings.code!==undefined,unmappedNumeric}),
    conflicts:validated.conflicts,assumptions:proposal.assumptions || [],approvalStatus:'AWAITING_APPROVAL',
    status:'READY',planVersion:1,createdAt:at};
  plan.integrityHash=integrityFor(plan,validated.rows);
  await database.transaction(async(client)=>{
    await client.query(`INSERT INTO import_plans(id,workspace_id,created_by_user_id,source_name,source_kind,source_hash,
      source_bytes,detected_type,sheet_name,sheet_index,source_columns,field_mappings,transformations,tracking_model,
      location_mappings,default_location_id,records_detected,records_valid,records_invalid,warnings,conflicts,assumptions,
      approval_status,status,plan_version,integrity_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [plan.id,ctx.workspaceId,ctx.actorId,plan.sourceName,plan.sourceKind,plan.sourceHash,plan.sourceBytes,
      plan.detectedType,plan.sheetName,plan.sheetIndex,JSON.stringify(plan.sourceColumns),JSON.stringify(plan.fieldMappings),
      JSON.stringify(plan.transformations),JSON.stringify(plan.trackingModel),'{}',plan.defaultLocationId,
      plan.recordsDetected,plan.recordsValid,plan.recordsInvalid,JSON.stringify(plan.warnings),JSON.stringify(plan.conflicts),
      JSON.stringify(plan.assumptions),plan.approvalStatus,plan.status,1,plan.integrityHash,at]);
    for(const row of validated.rows)await client.query(`INSERT INTO import_rows(id,import_id,workspace_id,row_number,raw,
      parsed,status,problems,location_id,quantity,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.id,plan.id,ctx.workspaceId,row.rowNumber,JSON.stringify(row.raw),JSON.stringify(row.parsed),row.status,
      JSON.stringify(row.problems),row.parsed.locationId,row.parsed.quantity,at]);
  },{isolation:'SERIALIZABLE'});
  return get(database,ctx.workspaceId,plan.id);
}

async function repairSupplierPreview(database,workspaceId,id,plan,mappings){
  await database.transaction(async(client)=>{
    const saved=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [workspaceId,id])).rows[0];
    if(!saved||saved.status!=='READY'||json(saved.transformations,{}).dataset==='suppliers')return;
    const raw=(await client.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2
      ORDER BY row_number,id FOR UPDATE`,[workspaceId,id])).rows.map(hydrateRow);
    const sheet={rows:raw.map((row)=>({sourceRow:row.rowNumber,cells:row.raw}))};
    const existing=(await client.query('SELECT name FROM suppliers WHERE workspace_id=$1',[workspaceId])).rows;
    const converted=supplierDataset.validate(sheet,mappings,existing.map((row)=>row.name));
    const valid=converted.filter((row)=>row.status==='VALID').length;
    const revised={...plan,fieldMappings:mappings,detectedType:'unknown',defaultLocationId:null,
      recordsValid:valid,recordsInvalid:converted.length-valid,transformations:{dataset:'suppliers'},
      planVersion:plan.planVersion+1};
    revised.integrityHash=integrityFor(revised,converted);
    await client.query(`UPDATE import_plans SET field_mappings=$3::jsonb,transformations=$4::jsonb,
      detected_type='unknown',default_location_id=NULL,records_valid=$5,records_invalid=$6,
      warnings=$7::jsonb,approval_status='AWAITING_APPROVAL',approved_by_user_id=NULL,approved_at=NULL,
      plan_version=$8,integrity_hash=$9 WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,id,JSON.stringify(mappings),JSON.stringify(revised.transformations),valid,revised.recordsInvalid,
      JSON.stringify(valid===converted.length?[]:[`${revised.recordsInvalid} supplier row(s) need correction or already exist.`]),
      revised.planVersion,revised.integrityHash]);
    for(let i=0;i<raw.length;i++)await client.query(`UPDATE import_rows SET parsed=$3::jsonb,status=$4,
      problems=$5::jsonb,location_id=NULL,quantity=NULL WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,raw[i].id,JSON.stringify(converted[i].parsed),converted[i].status,
      JSON.stringify(converted[i].problems)]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function get(database, workspaceId, id) {
  const result=await database.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2',[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError('That import could not be found.');
  const plan=hydratePlan(result.rows[0]);
  const supplierMapping=plan.status==='READY'&&!plan.transformations.dataset
    ?supplierDataset.classify(plan.sourceColumns):null;
  if(supplierMapping){await repairSupplierPreview(database,workspaceId,id,plan,supplierMapping);
    return hydratePlan((await database.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2',
      [workspaceId,id])).rows[0]);}
  return plan;
}

async function list(database, workspaceId, limit=10) {
  const result=await database.query(`SELECT * FROM import_plans WHERE workspace_id=$1
    ORDER BY created_at DESC,id DESC LIMIT $2`,[workspaceId,Math.min(100,Math.max(1,limit))]);
  return result.rows.map(hydratePlan);
}

async function rowsFor(database, workspaceId, importId, input={}) {
  const values=[workspaceId,importId];
  let status='';
  if(input.status){values.push(input.status);status=` AND status=$${values.length}`;}
  values.push(Math.min(500,Math.max(1,Number(input.limit)||50)),Math.max(0,Number(input.offset)||0));
  const result=await database.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2${status}
    ORDER BY row_number,id LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  return result.rows.map(hydrateRow);
}

async function counts(database, workspaceId, importId) {
  const result=await database.query(`SELECT status,COUNT(*) AS count FROM import_rows
    WHERE workspace_id=$1 AND import_id=$2 GROUP BY status`,[workspaceId,importId]);
  return Object.fromEntries(result.rows.map((row)=>[row.status,Number(row.count)]));
}

async function duplicates(database, workspaceId, plan) {
  const result=await database.query(`SELECT p.id,p.source_name,p.completed_at,p.created_at FROM import_plans p
    WHERE p.workspace_id=$1 AND p.source_hash=$2 AND p.id<>$3 AND p.status='SUCCEEDED'
    ORDER BY COALESCE(p.completed_at,p.created_at) DESC`,[workspaceId,plan.sourceHash,plan.id]);
  return result.rows;
}

async function revise(database,ctx,id,input={}){
  await assertOperator(database,ctx);
  return database.transaction(async(client)=>{
    const saved=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,id])).rows[0];
    if(!saved)throw new NotFoundError('That import could not be found.');
    const plan=hydratePlan(saved);
    if(plan.status!=='READY'||plan.approvalStatus!=='AWAITING_APPROVAL')
      throw new ValidationError('Only an unapproved preview can be corrected.');
    if(plan.transformations.dataset==='suppliers')
      throw new ValidationError('This is a supplier directory, not an inventory catalog. Review supplier rows on the preview.');
    if(plan.integrityHash!==input.expectedHash)throw new ValidationError('The preview changed. Review it before correcting rows.');
    const current=(await client.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2
      ORDER BY row_number,id FOR UPDATE`,[ctx.workspaceId,id])).rows.map(hydrateRow);
    let fieldMappings=plan.fieldMappings;
    if(input.fieldMappings!==undefined){
      const sourceIndexes=new Set(plan.sourceColumns.map((column)=>column.index));
      const entries=Object.entries(input.fieldMappings);
      if(entries.some(([field,index])=>!fields.FIELD_IDS.includes(field)||!sourceIndexes.has(index))||
        new Set(entries.map(([,index])=>index)).size!==entries.length)
        throw new ValidationError('Each registered import field must map to one source column, and each column may have only one meaning.');
      fieldMappings=Object.fromEntries(entries);
      if(fieldMappings.name===undefined&&fieldMappings.code===undefined)
        throw new ValidationError('Map a product name or SKU before recalculating this preview.');
    }
    const detectedType=fields.detectType(fieldMappings);
    if(detectedType==='unknown')throw new ValidationError('The selected columns do not identify products.');
    const allowedLocations=new Set(plan.conflicts.map((entry)=>entry.text));
    const locationMappings={...plan.locationMappings};
    for(const [source,value] of Object.entries(input.locationMappings||{})){
      if(!allowedLocations.has(source))throw new ValidationError('That source location is not in this preview.');
      if(value)locationMappings[source]=String(value);
    }
    const mappingChanged=stable(fieldMappings)!==stable(plan.fieldMappings);
    const quantityOverrides=mappingChanged?{}:{...(plan.transformations.quantityOverrides||{})};
    const rowNumbers=new Set(current.map((row)=>String(row.rowNumber)));
    for(const [number,value] of Object.entries(input.quantityOverrides||{})){
      if(!rowNumbers.has(String(number)))throw new ValidationError('That row is not in this preview.');
      if(String(value).trim())quantityOverrides[number]=String(value).trim();
    }
    const context=await workspaceContext(client,ctx.workspaceId);
    if(Object.values(locationMappings).some((value)=>!context.locations.some((row)=>row.id===value)))
      throw new ValidationError('Choose a location in this inventory for each correction.');
    const defaultLocationId=input.defaultLocationId===undefined
      ?plan.defaultLocationId:String(input.defaultLocationId||'');
    if(defaultLocationId&&!context.locations.some((row)=>row.id===defaultLocationId))
      throw new ValidationError('Choose a location in this inventory for this stock.');
    const sheet={columns:plan.sourceColumns,rows:current.map((row)=>({cells:row.raw,sourceRow:row.rowNumber}))};
    const axisNames=Object.fromEntries(fields.VARIANT_FIELDS.filter((field)=>fieldMappings[field]!==undefined)
      .map((field)=>[field,plan.sourceColumns.find((column)=>column.index===fieldMappings[field])?.name||field]));
    const validated=validateRows(sheet,fieldMappings,
      {detectedType,axisNames},context,
      {defaultLocationId,locationMappings,quantityOverrides});
    const unmappedNumeric=unmappedNumericColumns(sheet,fieldMappings);
    const confirmCatalogOnly=fieldMappings.quantity===undefined&&input.confirmCatalogOnly===true;
    const revised={...plan,fieldMappings,detectedType,locationMappings,defaultLocationId,
      transformations:{...plan.transformations,axisNames,quantityOverrides,
        unmappedNumericColumns:unmappedNumeric,confirmCatalogOnly},
      recordsValid:validated.summary.valid,recordsInvalid:validated.summary.invalid,
      warnings:previewWarnings(validated.summary,{hasQuantity:fieldMappings.quantity!==undefined,
        hasIdentity:fieldMappings.name!==undefined||fieldMappings.code!==undefined,unmappedNumeric}),
      conflicts:validated.conflicts,planVersion:plan.planVersion+1};
    revised.integrityHash=integrityFor(revised,validated.rows);
    await client.query(`UPDATE import_plans SET location_mappings=$3::jsonb,transformations=$4::jsonb,
      records_valid=$5,records_invalid=$6,warnings=$7::jsonb,conflicts=$8::jsonb,
      plan_version=$9,integrity_hash=$10,field_mappings=$11::jsonb,detected_type=$12,
      default_location_id=$13
      WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,JSON.stringify(locationMappings),JSON.stringify(revised.transformations),
      revised.recordsValid,revised.recordsInvalid,JSON.stringify(revised.warnings),JSON.stringify(revised.conflicts),
      revised.planVersion,revised.integrityHash,JSON.stringify(fieldMappings),detectedType,defaultLocationId||null]);
    for(const row of validated.rows)await client.query(`UPDATE import_rows SET parsed=$4::jsonb,status=$5,
      problems=$6::jsonb,location_id=$7,quantity=$8 WHERE workspace_id=$1 AND import_id=$2 AND row_number=$3`,
    [ctx.workspaceId,id,row.rowNumber,JSON.stringify(row.parsed),row.status,JSON.stringify(row.problems),
      row.parsed.locationId,row.parsed.quantity]);
    return revised;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(database, ctx, id, expectedHash) {
  await assertOperator(database,ctx);
  return database.transaction(async(client)=>{
    const result=await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id]);
    if(!result.rows.length)throw new NotFoundError('That import could not be found.');
    const plan=hydratePlan(result.rows[0]);
    if(!plan.transformations.dataset&&supplierDataset.classify(plan.sourceColumns))
      throw new ValidationError('This is a supplier directory. Reopen its preview so StockChief can safely classify it before approval.');
    if(plan.isExpired)throw new ValidationError('This preview is more than 24 hours old. Read the source again before importing.');
    if(plan.integrityHash!==expectedHash)throw new ValidationError('The preview changed. Review the current rows before approving.');
    if(plan.fieldMappings.name===undefined&&plan.fieldMappings.code===undefined)
      throw new ValidationError('Map a product name or SKU and recalculate the preview before approving.');
    if(!plan.recordsValid)throw new ValidationError('There are no valid rows to import.');
    if(plan.transformations.dataset!=='suppliers'&&plan.fieldMappings.quantity===undefined&&!plan.transformations.confirmCatalogOnly){
      const sourceRows=(await client.query(`SELECT raw FROM import_rows WHERE workspace_id=$1 AND import_id=$2`,
        [ctx.workspaceId,id])).rows.map((row)=>({cells:json(row.raw,[])}));
      if(unmappedNumericColumns({columns:plan.sourceColumns,rows:sourceRows},plan.fieldMappings).length)
        throw new ValidationError('A numeric source column was not mapped. Map the stock quantity or explicitly confirm a catalog-only import first.');
    }
    if((await client.query(`SELECT 1 FROM import_plans WHERE workspace_id=$1 AND source_hash=$2 AND id<>$3
      AND status='SUCCEEDED' LIMIT 1`,[ctx.workspaceId,plan.sourceHash,id])).rows.length)
      throw new ValidationError('This exact source has already been imported. StockChief will not apply it twice.');
    const at=nowIso();
    await client.query(`UPDATE import_plans SET approval_status='APPROVED',approved_by_user_id=$3,approved_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,at]);
    return {...plan,approvalStatus:'APPROVED',approvedByUserId:ctx.actorId,approvedAt:at};
  },{isolation:'SERIALIZABLE'});
}

function productKey(parsed) {
  if(parsed.existingSkuId)return `existing:${parsed.existingSkuId}`;
  if(parsed.variants.length)return `variants:${parsed.name.toLowerCase()}:${parsed.trackingMode}`;
  if(parsed.code)return `code:${parsed.code.toLowerCase()}`;
  return `name:${parsed.name.toLowerCase()}`;
}

function variantKey(parsed) {
  if(parsed.variants.length)return `options:${parsed.variants.map((part)=>`${part.name}:${part.value}`).join('|').toLowerCase()}`;
  if(parsed.code)return `code:${parsed.code.toLowerCase()}`;
  return 'default';
}

async function execute(database, ctx, id, options={}) {
  await assertOperator(database,ctx);
  const plan=await get(database,ctx.workspaceId,id);
  if(plan.approvalStatus!=='APPROVED')throw new ValidationError('Approve the preview before importing it.');
  const previous=(await database.query(`SELECT e.* FROM import_executions e JOIN import_plans p ON p.id=e.import_id
    WHERE e.workspace_id=$1 AND p.source_hash=$2 AND e.status='SUCCEEDED' ORDER BY e.finished_at DESC LIMIT 1`,
  [ctx.workspaceId,plan.sourceHash])).rows[0];
  if(previous)return {duplicate:true,execution:previous,planId:previous.import_id};
  const executionId=newId('impexec');
  const executionKey=`import:${plan.sourceHash}`;
  const at=nowIso();
  try {
    await database.query(`INSERT INTO import_executions(id,workspace_id,import_id,idempotency_key,executed_by_user_id,
      status,stage,started_at) VALUES($1,$2,$3,$4,$5,'EXECUTING','catalog',$6)`,
    [executionId,ctx.workspaceId,id,executionKey,ctx.actorId,at]);
  } catch(error) {
    if(error.code!=='23505')throw error;
    const replay=(await database.query('SELECT * FROM import_executions WHERE workspace_id=$1 AND idempotency_key=$2',
      [ctx.workspaceId,executionKey])).rows[0];
    return {replayed:true,execution:replay,planId:replay.import_id};
  }
  try {
    const result=await database.transaction(async(client)=>{
      const locked=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [ctx.workspaceId,id])).rows[0];
      if(!locked || locked.approval_status!=='APPROVED' || locked.integrity_hash!==plan.integrityHash)
        throw new ValidationError('The approved import is no longer executable.');
      const sourceRows=(await client.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2
        AND status IN ('VALID','NEEDS_REVIEW') ORDER BY row_number,id FOR UPDATE`,[ctx.workspaceId,id])).rows.map(hydrateRow);
      if(plan.transformations.dataset==='suppliers'){
        let created=0;
        for(const row of sourceRows){
          await commerce.createSupplierInTransaction(client,ctx,row.parsed);
          await client.query(`UPDATE import_rows SET status='IMPORTED',imported_at=$3
            WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,nowIso()]);
          created++;
        }
        const finishedAt=nowIso();
        const checks=[{name:'Suppliers created',expected:sourceRows.length,observed:created,
          ok:created===sourceRows.length}];
        const verificationId=newId('impverify');
        await client.query(`INSERT INTO import_verifications(id,workspace_id,import_id,execution_id,verified,checks,
          observed,problems,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'[]',$7)`,
        [verificationId,ctx.workspaceId,id,executionId,JSON.stringify(checks),JSON.stringify({suppliersCreated:created}),finishedAt]);
        await client.query(`UPDATE import_executions SET status='SUCCEEDED',stage='verified',
          rows_imported=$2,result=$3,finished_at=$4 WHERE id=$1`,
        [executionId,created,JSON.stringify({verificationId,verified:true,checks}),finishedAt]);
        await client.query(`UPDATE import_plans SET status='SUCCEEDED',completed_at=$3 WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,id,finishedAt]);
        return {executionId,verificationId,verified:true,checks,itemsCreated:0,skusCreated:0,
          rowsImported:created,suppliersCreated:created,units:0};
      }
      const grouped=new Map();
      for(const row of sourceRows){
        const key=productKey(row.parsed);
        if(!grouped.has(key))grouped.set(key,[]);
        grouped.get(key).push(row);
      }
      let itemsCreated=0;let skusCreated=0;let units=0;let rowsImported=0;
      const salePriceBySku=new Map();
      for(const [key,group] of grouped){
        if(options.beforeGroup)await options.beforeGroup({key,group,itemsCreated});
        const skuByVariant=new Map();
        if(key.startsWith('existing:'))skuByVariant.set('existing',group[0].parsed.existingSkuId);
        else {
          const distinct=[];const seen=new Set();
          for(const row of group){const variant=variantKey(row.parsed);if(seen.has(variant))continue;seen.add(variant);
            distinct.push({key:variant,code:row.parsed.code,barcode:row.parsed.barcode,options:row.parsed.variants});}
          const first=group[0].parsed;
          const created=await catalog.createImportedItemInTransaction(client,ctx,{name:first.name,description:first.description,
            unitLabel:first.unitLabel,trackingMode:first.trackingMode,variants:distinct});
          itemsCreated+=1;skusCreated+=created.skus.length;
          for(const sku of created.skus)skuByVariant.set(sku.key,sku.skuId);
          for(const row of group)row.parsed.createdItemId=created.itemId;
        }
        for(const row of group){
          if(options.beforeRow)await options.beforeRow({row,rowsImported});
          const skuId=row.parsed.existingSkuId || skuByVariant.get(key.startsWith('existing:')?'existing':variantKey(row.parsed));
          const itemId=row.parsed.existingItemId || row.parsed.createdItemId;
          if(row.parsed.sellingPriceMinor!==null){
            const saleKey=`${row.parsed.currency}:${row.parsed.sellingPriceMinor}`;
            if(salePriceBySku.has(skuId)&&salePriceBySku.get(skuId)!==saleKey)
              throw new ValidationError(`Conflicting selling prices for ${row.parsed.name} in this import.`);
            if(!salePriceBySku.has(skuId)){
              await postgresPrices.setPriceInTransaction(client,ctx,{skuId,
                amountMinor:row.parsed.sellingPriceMinor,currency:row.parsed.currency,
                source:'opening_import',sourceDetail:{importId:id,importRowId:row.id}});
              salePriceBySku.set(skuId,saleKey);
            }
          }
          const movementIds=[];
          if(row.parsed.quantity>0){
            const received=await inventory.receiveInTransaction(client,ctx,{skuId,locationId:row.parsed.locationId,
              quantity:row.parsed.quantity,serials:row.parsed.serial?[row.parsed.serial]:undefined,
              lotCode:row.parsed.lotCode,expiresAt:row.parsed.expiresAt,lotReceivedAt:row.parsed.receivedAt,
              notes:row.parsed.notes,reference:`Import ${plan.sourceName} row ${row.rowNumber}`,
              idempotencyKey:`import:${id}:row:${row.id}`});
            movementIds.push(received.movementId);units+=row.parsed.quantity;
            if(row.parsed.unitCostMinor!==null){
              const totalCostMinor=row.parsed.quantity*row.parsed.unitCostMinor;
              let journalEntryId=null;
              if(totalCostMinor>0){
                const posted=await ledger.postInTransaction(client,ctx,{
                  postingDate:nowIso().slice(0,10),sourceKey:`import:${id}:row:${row.id}:opening-value`,
                  sourceType:'opening_inventory',sourceRecordType:'import_row',sourceRecordId:row.id,
                  description:`Opening inventory from ${plan.sourceName}, row ${row.rowNumber}`,
                  currency:row.parsed.currency,
                  lines:[{accountKey:'INVENTORY_ASSET',debitMinor:totalCostMinor,skuId,locationId:row.parsed.locationId},
                    {accountKey:'OPENING_BALANCE_EQUITY',creditMinor:totalCostMinor}],
                });
                journalEntryId=posted.entry.id;
              }
              await costing.receiveInTransaction(client,ctx,{movementId:received.movementId,totalCostMinor,
                unitCostMinor:row.parsed.unitCostMinor,journalEntryId,
                sourceType:'opening_inventory',sourceRecordId:row.id});
            }
          }
          await client.query(`UPDATE import_rows SET status='IMPORTED',item_id=$3,sku_id=$4,location_id=$5,
            movement_ids=$6,quantity=$7,imported_at=$8 WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,row.id,itemId,skuId,row.parsed.locationId,JSON.stringify(movementIds),row.parsed.quantity,nowIso()]);
          rowsImported+=1;
        }
      }
      const finishedAt=nowIso();
      const checks=[{name:'Rows imported',expected:sourceRows.length,observed:rowsImported,ok:sourceRows.length===rowsImported},
        {name:'Opening units',expected:sourceRows.reduce((sum,row)=>sum+(row.parsed.quantity || 0),0),observed:units,
          ok:sourceRows.reduce((sum,row)=>sum+(row.parsed.quantity || 0),0)===units}];
      const valuedRows=sourceRows.filter((row)=>row.parsed.quantity>0&&row.parsed.unitCostMinor!==null);
      const valuedIds=valuedRows.map((row)=>row.id);
      const expectedValue=valuedRows.reduce((sum,row)=>sum+row.parsed.quantity*row.parsed.unitCostMinor,0);
      const value=(await client.query(`SELECT COALESCE(SUM(cost_delta_minor),0)::bigint AS value,
        COUNT(*)::int AS movements FROM accounting_inventory_cost_movements
        WHERE workspace_id=$1 AND cost_source_type='opening_inventory' AND cost_source_record_id=ANY($2::text[])`,
      [ctx.workspaceId,valuedIds])).rows[0];
      const posted=(await client.query(`SELECT COALESCE(SUM(l.debit_minor),0)::bigint AS value
        FROM accounting_journal_entries e JOIN accounting_journal_lines l
          ON l.entry_id=e.id AND l.workspace_id=e.workspace_id
        JOIN accounting_accounts a ON a.id=l.account_id AND a.workspace_id=l.workspace_id
        WHERE e.workspace_id=$1 AND e.source_type='opening_inventory'
          AND e.source_record_id=ANY($2::text[]) AND a.system_key='INVENTORY_ASSET'`,
      [ctx.workspaceId,valuedIds])).rows[0];
      checks.push({name:'Valued receipt records',expected:valuedRows.length,observed:Number(value.movements),
        ok:valuedRows.length===Number(value.movements)},
      {name:'Opening cost in cents',expected:expectedValue,observed:Number(value.value),
        ok:expectedValue===Number(value.value)},
      {name:'Inventory asset posted in cents',expected:expectedValue,observed:Number(posted.value),
        ok:expectedValue===Number(posted.value)});
      const verified=checks.every((check)=>check.ok);
      const verificationId=newId('impverify');
      await client.query(`INSERT INTO import_verifications(id,workspace_id,import_id,execution_id,verified,checks,
        observed,problems,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [verificationId,ctx.workspaceId,id,executionId,verified?1:0,JSON.stringify(checks),
        JSON.stringify({itemsCreated,skusCreated,rowsImported,units}),verified?'[]':JSON.stringify(['Import totals did not reconcile.']),finishedAt]);
      await client.query(`UPDATE import_executions SET status=$2,stage='verified',items_created=$3,skus_created=$4,
        rows_imported=$5,units_established=$6,result=$7,finished_at=$8 WHERE id=$1`,
      [executionId,verified?'SUCCEEDED':'FAILED',itemsCreated,skusCreated,rowsImported,units,
        JSON.stringify({verificationId,verified,checks}),finishedAt]);
      await client.query(`UPDATE import_plans SET status=$3,completed_at=$4 WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id,verified?'SUCCEEDED':'FAILED',finishedAt]);
      return {executionId,verificationId,verified,checks,itemsCreated,skusCreated,rowsImported,units};
    },{isolation:'SERIALIZABLE',retrySafe:true});
    return result;
  } catch(error) {
    await database.query(`UPDATE import_executions SET status='FAILED',stage='rolled_back',error_message=$2,finished_at=$3
      WHERE id=$1`,[executionId,String(error.message).slice(0,1000),nowIso()]);
    await database.query(`UPDATE import_plans SET status='READY' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    throw error;
  }
}

async function report(database, workspaceId, id) {
  const result=await database.query(`SELECT e.*,v.verified,v.checks,v.observed,v.problems FROM import_executions e
    LEFT JOIN import_verifications v ON v.execution_id=e.id
    WHERE e.workspace_id=$1 AND e.import_id=$2 ORDER BY e.started_at DESC LIMIT 1`,[workspaceId,id]);
  if(!result.rows.length)return null;
  const row=result.rows[0];
  return {id:row.id,status:row.status,stage:row.stage,itemsCreated:Number(row.items_created),
    skusCreated:Number(row.skus_created),rowsImported:Number(row.rows_imported),unitsEstablished:Number(row.units_established),
    verified:Number(row.verified)===1,checks:json(row.checks,[]),observed:json(row.observed,{}),
    problems:json(row.problems,[]),errorMessage:row.error_message};
}

async function cancel(database, ctx, id) {
  await assertOperator(database,ctx);
  const result=await database.query(`UPDATE import_plans SET status='CANCELLED',approval_status='CANCELLED'
    WHERE workspace_id=$1 AND id=$2 AND status='READY' RETURNING id`,[ctx.workspaceId,id]);
  if(!result.rows.length)throw new ValidationError('Only an import waiting to run can be cancelled.');
}

module.exports={analyse,get,list,rowsFor,counts,duplicates,revise,approve,execute,report,cancel,hydratePlan,hydrateRow};
require('../commercial/enforcement').guardExports(module.exports,0,1,{analyse:'imports.spreadsheet',approve:'imports.spreadsheet',
  revise:'imports.spreadsheet',execute:'imports.spreadsheet',cancel:'imports.spreadsheet'});
