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
const plannedLocations = require('./planned-locations');
const rowStore = require('./postgres-row-store');
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
    const problems=proposal.problemsIndex===undefined?[...(row.problems||[])]:json(textCell(row,proposal.problemsIndex),[]);
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
    if(unitCostMinor!==null&&quantity===null)
      problems.push(problem('cost_without_stock','A source unit cost needs an explicit stock quantity, including zero. No cost will be silently discarded.'));
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
    const variants=proposal.variantColumns?.length?proposal.variantColumns.map(part=>({name:part.name,value:trimOrNull(textCell(row,part.index))})).filter(part=>part.value):
      fields.VARIANT_FIELDS.map((field)=>({name:proposal.axisNames[field] || fields.FIELD_LABEL[field],
      value:trimOrNull(textCell(row,mappings[field]))})).filter((entry)=>entry.value);
    const serial=trimOrNull(textCell(row,mappings.serial));
    const lotCode=trimOrNull(textCell(row,mappings.lotCode));
    const flag=field=>{const value=textCell(row,mappings[field]);if(!value)return false;if(/^(?:yes|true|1)$/i.test(value))return true;if(/^(?:no|false|0)$/i.test(value))return false;problems.push(problem('invalid_tracking_flag','A tracking requirement must be an explicit yes/no value.'));return false;};
    const serialFlag=flag('serialTracked'),lotFlag=flag('lotTracked');
    const serialRequired=mappings.serial!==undefined||proposal.detectedType==='serials'||(serialFlag&&proposal.trackingReview?.serial!=='quantity');
    const lotRequired=mappings.lotCode!==undefined||proposal.detectedType==='lots'||(lotFlag&&proposal.trackingReview?.lot!=='quantity');
    if(serialRequired&&lotRequired)problems.push(problem('invalid_tracking_flag','A product cannot use both serial and lot tracking in the same import row.'));
    if(serialRequired){
      if(!serial&&quantity!==0)problems.push(problem('missing_serial','A serial number is required for this row.'));
      if(quantity === null)quantity=1;
      if(quantity !== 1&&quantity!==0)problems.push(problem('serial_quantity','Each serial-number row must represent exactly one unit.'));
    }
    if(lotRequired && quantity > 0 && !lotCode)problems.push(problem('missing_lot','A lot or batch number is required.'));
    const existingMatches=code ? (context.skuByCode.get(code.toLowerCase()) || []) : [];
    if(existingMatches.length>1)problems.push(problem('ambiguous_existing_code','This SKU code matches more than one active record.'));
    const blocking=new Set(['bad_quantity','negative_quantity','fractional_quantity','bad_unit_cost','cost_without_stock','bad_selling_price',
      'accounting_not_ready','cost_currency_mismatch','cost_overflow','no_product','unknown_location','no_location',
      'missing_serial','serial_quantity','missing_lot','invalid_tracking_flag','ambiguous_existing_code','workbook_unmatched_key','workbook_stock_mismatch']);
    const parsed={name,code,description:trimOrNull(textCell(row,mappings.description)),
      unitLabel:trimOrNull(textCell(row,mappings.unitLabel)) || 'unit',barcode:trimOrNull(textCell(row,mappings.barcode)),
      unitCostMinor,sellingPriceMinor,currency,
      quantity,variants,locationId:location?.id || null,locationName:location?.name || null,locationText,
      ...(location?.proposed?{proposedLocationName:location.name}:{}),
      serial,lotCode,expiresAt:trimOrNull(textCell(row,mappings.expiresAt)),
      receivedAt:trimOrNull(textCell(row,mappings.receivedAt)),notes:trimOrNull(textCell(row,mappings.notes)),
      trackingMode:serialRequired?'serial':lotRequired?'lot':'quantity',
      ...(proposal.provenanceIndex!==undefined?{sourceRows:json(textCell(row,proposal.provenanceIndex),{})}:{}),
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
      .reduce((sum,row)=>sum+(row.parsed.quantity||0)*row.parsed.unitCostMinor,0),
    sourceCostWithoutStock:rows.filter(row=>row.status==='VALID'&&row.parsed.quantity===0&&row.parsed.unitCostMinor!==null).length},
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
  if(summary.sourceCostWithoutStock)warnings.push(`${summary.sourceCostWithoutStock} zero-stock row(s) include a source unit cost. That evidence is retained with the imported row; it creates no stock, inventory value or purchase quote.`);
  if(!hasQuantity)warnings.push('No quantity column is mapped. This preview would create or match products without establishing opening stock.');
  if(unmappedNumeric.length)warnings.push(`Unmapped numeric column${unmappedNumeric.length===1?'':'s'}: ${unmappedNumeric.join(', ')}. Map any stock quantity before approval, or explicitly confirm this is catalog-only data.`);
  return warnings;
}

function integrityStream(plan) {
  const metadata={sourceHash:plan.sourceHash,detectedType:plan.detectedType,fieldMappings:plan.fieldMappings,
    ...(plan.transformations?.workbook?{workbook:plan.transformations.workbook}:{}),
    ...(plan.transformations?.trackingReview?{trackingReview:plan.transformations.trackingReview}:{}),
    ...(plan.transformations?.proposedLocations?.length?{proposedLocations:plan.transformations.proposedLocations}:{}),
    defaultLocationId:plan.defaultLocationId};
  // Identical canonical bytes to stable({...metadata,rows:[...]}), without
  // constructing a second complete row array and giant JSON string. The
  // original approvals remain compatible; large workbooks have bounded hash
  // working memory instead of duplicating the full preview.
  const hash=crypto.createHash('sha256'),keys=[...Object.keys(metadata),'rows'].sort(),at=keys.indexOf('rows');hash.update('{');
  for(let i=0;i<at;i++)hash.update((i?',':'')+JSON.stringify(keys[i])+':'+stable(metadata[keys[i]]));
  hash.update((at?',':'')+'"rows":[');let count=0,finished=false;
  return {append(row){if(finished)throw new Error('IMPORT_HASH_ALREADY_FINISHED');if(count++)hash.update(',');hash.update(stable({rowNumber:row.rowNumber,parsed:row.parsed,status:row.status}));},
    finish(){if(finished)throw new Error('IMPORT_HASH_ALREADY_FINISHED');finished=true;hash.update(']');for(let i=at+1;i<keys.length;i++)hash.update(','+JSON.stringify(keys[i])+':'+stable(metadata[keys[i]]));hash.update('}');return hash.digest('hex');}};
}
function integrityFor(plan,rows){const stream=integrityStream(plan);for(const row of rows)stream.append(row);return stream.finish();}

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
  let sheet=parsedWorkbook.sheets[sheetIndex];
  if(!sheet?.rows.length)throw new ValidationError('That source has no inventory rows.');
  const supplierMapping=supplierDataset.classify(sheet.columns);
  if(supplierMapping)return saveSupplierPreview(database,ctx,{bytes,sourceHash,filename:input.filename,
    sheet,sheetIndex,format:parsedWorkbook.format,mappings:supplierMapping});
  const prior=(await database.query(`SELECT field_mappings,detected_type FROM import_plans
    WHERE workspace_id=$1 AND source_hash=$2 AND approval_status='APPROVED' AND status<>'CANCELLED'
    ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ctx.workspaceId,sourceHash])).rows[0];
  const modelProvider=input.allowModel===false?null:input.provider||(require('../config').ai.configured?
    require('../ai/provider').createProviderUnobserved(require('../config').ai.provider,require('../config').ai.tier('fast')):null);
  const wrappedProvider=modelProvider?require('../commercial/model').wrap(database,ctx,modelProvider,'import_mapping',input.usageKey||require('./usage-key').analysisUsageKey(sourceHash)):null;
  const workbook=parsedWorkbook.format==='xlsx'&&parsedWorkbook.sheets.length>1
    ?await require('./workbook-relations').interpret(parsedWorkbook,{provider:wrappedProvider,
      contract:input.workbookContract,onBeforeAi:input.onBeforeAi,onUsage:input.onUsage}):null;
  if(workbook)sheet=workbook.sheet;
  const proposal=workbook?{mappings:workbook.mappings,detectedType:workbook.variantColumns.length?'variant_inventory':fields.detectType(workbook.mappings),
    axisNames:workbook.axisNames,variantColumns:workbook.variantColumns,provenanceIndex:workbook.provenanceIndex,problemsIndex:workbook.problemsIndex,
    aiUsed:!input.workbookContract,ignoredColumns:[],assumptions:[]}:await mappingService.proposeMappings({...sheet,sourceName:input.filename || 'pasted data'},
    {provider:wrappedProvider,allowModel:input.allowModel,
      mappings:input.mappings || json(prior?.field_mappings,null),detectedType:input.detectedType || prior?.detected_type,
      onBeforeAi:input.onBeforeAi,onUsage:input.onUsage});
  // An uncertain interpretation is a review task, not an upload failure. Keep
  // the source columns and rows in an unapproved preview so the operator can
  // identify the product column without editing and re-uploading the file.
  const context=await workspaceContext(database,ctx.workspaceId);
  if(input.defaultLocationId && !context.locations.some((row)=>row.id===input.defaultLocationId))
    throw new ValidationError('That destination location is not in this inventory.');
  const proposedLocations=plannedLocations.proposals(sheet,proposal.mappings,context,input);
  const streaming=Boolean(workbook)&&sheet.rows.length>500;
  const validationContext=plannedLocations.withProposals(context,proposedLocations);
  const validated=validateRows(streaming?{...sheet,rows:[]}:sheet,proposal.mappings,proposal,validationContext,input);
  const unmappedNumeric=unmappedNumericColumns(sheet,proposal.mappings);
  const at=nowIso();
  const plan={id:newId('imp'),workspaceId:ctx.workspaceId,createdByUserId:ctx.actorId,
    sourceName:input.filename || 'Pasted inventory data',sourceKind:buffer?parsedWorkbook.format==='pdf'
      ?'pdf':parsedWorkbook.format==='image'?'image':parsedWorkbook.format==='xlsx'?'xlsx':'csv':'paste',
    sourceHash,sourceBytes:bytes.length,detectedType:proposal.detectedType,sheetName:sheet.name,
    sheetIndex,sourceColumns:sheet.columns.map((column)=>({index:column.index,name:column.name})),
    fieldMappings:proposal.mappings,transformations:{axisNames:proposal.axisNames,aiUsed:proposal.aiUsed,
      ...(workbook?{workbook:{version:1,contract:workbook.contract,coverage:workbook.coverage,sourceRows:workbook.sourceRows,
        outputRows:workbook.outputRows,physicalUnits:workbook.physicalUnits,issues:workbook.issues,issueCount:workbook.issueCount},
        variantColumns:workbook.variantColumns,provenanceIndex:workbook.provenanceIndex,problemsIndex:workbook.problemsIndex}:{}),
      ignoredColumns:proposal.ignoredColumns,sheetCount:parsedWorkbook.sheets.length,
      unmappedNumericColumns:unmappedNumeric,confirmCatalogOnly:false,proposedLocations},trackingModel:{mode:'per-row'},
    locationMappings:{},defaultLocationId:validated.defaultLocationId,recordsDetected:streaming?sheet.rows.length:validated.summary.total,
    recordsValid:validated.summary.valid,recordsInvalid:validated.summary.invalid,
    warnings:[...(parsedWorkbook.sheets.length>1&&!workbook?[`Only “${sheet.name}” was interpreted. The other ${parsedWorkbook.sheets.length-1} sheets have not been linked or imported; review the complete workbook before approval.`]:[]),
      ...previewWarnings(validated.summary,{hasQuantity:proposal.mappings.quantity!==undefined,
      hasIdentity:proposal.mappings.name!==undefined||proposal.mappings.code!==undefined,unmappedNumeric})],
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
    if(!streaming){await rowStore.insert(client,ctx.workspaceId,plan.id,validated.rows,at);return;}
    const hash=integrityStream(plan),summary={...validated.summary},conflicts=new Map();
    for(let start=0;start<sheet.rows.length;start+=500){
      const batch=validateRows({...sheet,rows:sheet.rows.slice(start,start+500)},proposal.mappings,proposal,validationContext,input);
      for(const row of batch.rows)hash.append(row);
      for(const key of Object.keys(summary))summary[key]+=batch.summary[key];
      for(const c of batch.conflicts)conflicts.set(c.text,{...c,count:(conflicts.get(c.text)?.count||0)+c.count});
      await rowStore.insert(client,ctx.workspaceId,plan.id,batch.rows,at);
    }
    plan.integrityHash=hash.finish();plan.recordsValid=summary.valid;plan.recordsInvalid=summary.invalid;plan.conflicts=[...conflicts.values()];
    plan.warnings=previewWarnings(summary,{hasQuantity:proposal.mappings.quantity!==undefined,
      hasIdentity:proposal.mappings.name!==undefined||proposal.mappings.code!==undefined,unmappedNumeric});
    await client.query(`UPDATE import_plans SET records_valid=$3,records_invalid=$4,warnings=$5,conflicts=$6,integrity_hash=$7 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,plan.id,plan.recordsValid,plan.recordsInvalid,JSON.stringify(plan.warnings),JSON.stringify(plan.conflicts),plan.integrityHash]);
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
  return hydratePlan(result.rows[0]);
}

// Legacy preview conversion invalidates approval and requires row locks.
// It belongs to an authorized mutation, never viewing an import or agent read.
async function getForMutation(database,workspaceId,id){
  const plan=await get(database,workspaceId,id);
  const supplierMapping=plan.status==='READY'&&!plan.transformations.dataset
    &&!plan.isExpired?supplierDataset.classify(plan.sourceColumns):null;
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
  await getForMutation(database,ctx.workspaceId,id);
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
    if(plan.transformations.workbook&&(fieldMappings.quantity!==plan.fieldMappings.quantity||fieldMappings.location!==plan.fieldMappings.location||Object.keys(input.quantityOverrides||{}).length))
      throw new ValidationError('Correct quantities or location columns in the source workbook and prepare a new preview so the physical totals can be checked again.');
    const detectedType=fields.detectType(fieldMappings);
    if(detectedType==='unknown')throw new ValidationError('The selected columns do not identify products.');
    const allowedLocations=new Set([...plan.conflicts.map((entry)=>entry.text),...(plan.transformations.proposedLocations||[]).map(row=>row.source)]);
    const locationMappings={...plan.locationMappings};
    for(const [source,value] of Object.entries(input.locationMappings||{})){
      if(!allowedLocations.has(source))throw new ValidationError('That source location is not in this preview.');
      if(value)locationMappings[source]=String(value);
    }
    const mappingChanged=stable(fieldMappings)!==stable(plan.fieldMappings);
    const quantityOverrides=mappingChanged?{}:{...(plan.transformations.quantityOverrides||{})};
    for(const [number,value] of Object.entries(input.quantityOverrides||{})){
      if(!/^\d+$/.test(number)||!(await client.query('SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND row_number=$3',[ctx.workspaceId,id,number])).rows.length)
        throw new ValidationError('That row is not in this preview.');
      if(String(value).trim())quantityOverrides[number]=String(value).trim();
    }
    let trackingReview=mappingChanged?null:plan.transformations.trackingReview;
    if(input.trackingReview!==undefined){
      const choices=input.trackingReview;
      if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).some(k=>!['serial','lot'].includes(k))||
        Object.values(choices).some(v=>!['source','quantity'].includes(v)))throw new ValidationError('Choose how to handle each tracking requirement in this preview.');
      for(const [mode,flagField,identifier] of [['serial','serialTracked','serial'],['lot','lotTracked','lotCode']]){
        if(choices[mode]==='quantity'&&(fieldMappings[flagField]===undefined||fieldMappings[identifier]!==undefined))
          throw new ValidationError('Actual serial or lot identifiers cannot be discarded through a tracking-flag confirmation.');
      }
      if(input.confirmTrackingChange!==true&&Object.values(choices).includes('quantity'))
        throw new ValidationError('Confirm that the selected tracking flags do not apply before preparing quantity-only stock.');
      trackingReview={serial:choices.serial||'source',lot:choices.lot||'source',confirmedBy:ctx.actorId,confirmedAt:nowIso()};
    }
    const context=await workspaceContext(client,ctx.workspaceId);
    if(Object.values(locationMappings).some((value)=>!context.locations.some((row)=>row.id===value)))
      throw new ValidationError('Choose a location in this inventory for each correction.');
    const defaultLocationId=input.defaultLocationId===undefined
      ?plan.defaultLocationId:String(input.defaultLocationId||'');
    if(defaultLocationId&&!context.locations.some((row)=>row.id===defaultLocationId))
      throw new ValidationError('Choose a location in this inventory for this stock.');
    const axisNames=Object.fromEntries(fields.VARIANT_FIELDS.filter((field)=>fieldMappings[field]!==undefined)
      .map((field)=>[field,plan.sourceColumns.find((column)=>column.index===fieldMappings[field])?.name||field]));
    // Location labels are distinct source facts, not the entire (potentially
    // very large) row set. Row validation and updates below use bounded pages.
    const locationFacts=fieldMappings.location===undefined?[]:(await client.query(`SELECT DISTINCT raw::jsonb ->> $3::int AS value FROM import_rows WHERE workspace_id=$1 AND import_id=$2`,[ctx.workspaceId,id,fieldMappings.location])).rows;
    const locationSheet={columns:plan.sourceColumns,rows:locationFacts.map(row=>({cells:{[fieldMappings.location]:row.value}}))};
    const proposedLocations=plannedLocations.proposals(locationSheet,fieldMappings,context,{locationMappings,
      proposedLocations:{...Object.fromEntries((plan.transformations.proposedLocations||[]).map(row=>[row.source,row])),...(input.proposedLocations||{})}});
    let unmappedNumeric=[];
    if(fieldMappings.quantity===undefined){
      const numericSource=(await client.query('SELECT raw FROM import_rows WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_number,id',[ctx.workspaceId,id])).rows;
      unmappedNumeric=unmappedNumericColumns({columns:plan.sourceColumns,rows:numericSource.map(row=>({cells:json(row.raw,[])}))},fieldMappings);
    }
    const confirmCatalogOnly=fieldMappings.quantity===undefined&&input.confirmCatalogOnly===true;
    const revised={...plan,fieldMappings,detectedType,locationMappings,defaultLocationId,
      transformations:{...plan.transformations,axisNames,quantityOverrides,
        ...(trackingReview?{trackingReview}:{}),
        unmappedNumericColumns:unmappedNumeric,confirmCatalogOnly,proposedLocations},
      planVersion:plan.planVersion+1};
    if(!trackingReview)delete revised.transformations.trackingReview;
    const hash=integrityStream(revised),summary={total:0,valid:0,invalid:0,units:0,unvaluedUnits:0,valuedMinor:0,sourceCostWithoutStock:0},conflicts=new Map();
    let lastRow=0,lastId='';
    for(;;){
      const current=(await client.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND (row_number,id)>($3::bigint,$4::text) ORDER BY row_number,id LIMIT 500 FOR UPDATE`,[ctx.workspaceId,id,lastRow,lastId])).rows.map(hydrateRow);
      if(!current.length)break;
      const validated=validateRows({columns:plan.sourceColumns,rows:current.map(row=>({cells:row.raw,sourceRow:row.rowNumber}))},fieldMappings,
        {detectedType,axisNames,variantColumns:plan.transformations.variantColumns,provenanceIndex:plan.transformations.provenanceIndex,problemsIndex:plan.transformations.problemsIndex,trackingReview},plannedLocations.withProposals(context,proposedLocations),
        {defaultLocationId,locationMappings,quantityOverrides});
      for(const row of validated.rows)hash.append(row);
      for(const key of Object.keys(summary))summary[key]+=validated.summary[key];
      for(const conflict of validated.conflicts)conflicts.set(conflict.text,(conflicts.get(conflict.text)||0)+conflict.count);
      await rowStore.revise(client,ctx.workspaceId,id,current,validated.rows);
      lastRow=current.at(-1).rowNumber;lastId=current.at(-1).id;
    }
    revised.integrityHash=hash.finish();revised.recordsValid=summary.valid;revised.recordsInvalid=summary.invalid;
    revised.warnings=previewWarnings(summary,{hasQuantity:fieldMappings.quantity!==undefined,hasIdentity:fieldMappings.name!==undefined||fieldMappings.code!==undefined,unmappedNumeric});
    revised.conflicts=[...conflicts].map(([text,count])=>({kind:'unknown_location',text,count}));
    await client.query(`UPDATE import_plans SET location_mappings=$3::jsonb,transformations=$4::jsonb,
      records_valid=$5,records_invalid=$6,warnings=$7::jsonb,conflicts=$8::jsonb,
      plan_version=$9,integrity_hash=$10,field_mappings=$11::jsonb,detected_type=$12,
      default_location_id=$13
      WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,JSON.stringify(locationMappings),JSON.stringify(revised.transformations),
      revised.recordsValid,revised.recordsInvalid,JSON.stringify(revised.warnings),JSON.stringify(revised.conflicts),
      revised.planVersion,revised.integrityHash,JSON.stringify(fieldMappings),detectedType,defaultLocationId||null]);
    return revised;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(database, ctx, id, expectedHash) {
  await assertOperator(database,ctx);
  await getForMutation(database,ctx.workspaceId,id);
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
    if(plan.transformations.workbook&&plan.recordsInvalid)throw new ValidationError('This workbook still has unresolved source rows. Resolve them before approving the complete inventory; StockChief will not silently import only part of it.');
    await plannedLocations.assertOwner(client,ctx,plan.transformations.proposedLocations||[]);
    if(plan.transformations.proposedLocations?.length)await require('../entitlements/postgres-service').assertMeterCapacity(client,
      await require('../entitlements/postgres-service').ownerScopeForWorkspace(client,ctx.workspaceId),'locations',plan.transformations.proposedLocations.length);
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
  if(parsed.code||parsed.variants.length)return stable({code:parsed.code?.toLowerCase()||null,
    options:parsed.variants.map(part=>[part.name.toLowerCase(),part.value.toLowerCase()]).sort((a,b)=>a[0].localeCompare(b[0]))});
  return 'default';
}

async function execute(database, ctx, id, options={}) {
  await assertOperator(database,ctx);
  const plan=await getForMutation(database,ctx.workspaceId,id);
  if(plan.approvalStatus!=='APPROVED')throw new ValidationError('Approve the preview before importing it.');
  const previous=(await database.query(`SELECT e.* FROM import_executions e JOIN import_plans p ON p.id=e.import_id
    WHERE e.workspace_id=$1 AND p.source_hash=$2 AND e.status='SUCCEEDED' ORDER BY e.finished_at DESC LIMIT 1`,
  [ctx.workspaceId,plan.sourceHash])).rows[0];
  if(previous)return {duplicate:true,execution:previous,planId:previous.import_id};
  const executionId=newId('impexec');
  if(options.retryExecutionId)await requireRolledBackExecution(database,ctx,plan,options.retryExecutionId);
  const executionKey=`import:${plan.sourceHash}${options.retryExecutionId?':retry:'+options.retryExecutionId:''}`;
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
  let result;
  try {
    result=await database.transaction(async(client)=>{
      const locked=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [ctx.workspaceId,id])).rows[0];
      if(!locked || locked.approval_status!=='APPROVED' || locked.integrity_hash!==plan.integrityHash)
        throw new ValidationError('The approved import is no longer executable.');
      const sourceRows=(await client.query(`SELECT * FROM import_rows WHERE workspace_id=$1 AND import_id=$2
        AND status IN ('VALID','NEEDS_REVIEW') ORDER BY row_number,id FOR UPDATE`,[ctx.workspaceId,id])).rows.map(hydrateRow);
      const publishProgress=(stage,processedRows)=>options.onProgress?.({stage,processedRows,totalRows:sourceRows.length});
      publishProgress('preparing',0);
      if(plan.transformations.dataset==='suppliers'){
        let created=0;
        for(const row of sourceRows){
          await commerce.createSupplierInTransaction(client,ctx,row.parsed);
          await client.query(`UPDATE import_rows SET status='IMPORTED',imported_at=$3
            WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,nowIso()]);
          created++;
          publishProgress('processing',created);
        }
        publishProgress('verifying',created);
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
        await options.beforeCommit?.();
        return {executionId,verificationId,verified:true,checks,itemsCreated:0,skusCreated:0,
          rowsImported:created,suppliersCreated:created,units:0};
      }
      const newLocations=await plannedLocations.materialize(client,ctx,plan.transformations.proposedLocations||[]);
      for(const row of sourceRows)if(row.parsed.proposedLocationName){
        const locationId=newLocations.get(row.parsed.proposedLocationName);
        if(!locationId)throw new ValidationError('This row has no approved location proposal. Recalculate the import.');
        row.parsed={...row.parsed,locationId};
      }
      const grouped=new Map();
      for(const row of sourceRows){
        const key=productKey(row.parsed);
        if(!grouped.has(key))grouped.set(key,[]);
        grouped.get(key).push(row);
      }
      let itemsCreated=0;let skusCreated=0;let units=0;let rowsImported=0;
      const salePriceBySku=new Map();
      let savedRows=[];
      let pendingValues=[];
      async function flushValues(){
        if(!pendingValues.length)return;
        const valued=pendingValues.filter(value=>value.totalCostMinor>0),posted=await ledger.postManyInTransaction(client,ctx,valued.map(value=>({
          postingDate:value.postingDate,sourceKey:`import:${id}:row:${value.row.id}:opening-value`,sourceType:'opening_inventory',sourceRecordType:'import_row',sourceRecordId:value.row.id,
          description:`Opening inventory from ${plan.sourceName}, row ${value.row.rowNumber}`,currency:value.row.parsed.currency,
          lines:[{accountKey:'INVENTORY_ASSET',debitMinor:value.totalCostMinor,skuId:value.skuId,locationId:value.row.parsed.locationId},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:value.totalCostMinor}]})));
        let journalIndex=0;
        await costing.receiveManyInTransaction(client,ctx,pendingValues.map(value=>({movementId:value.movementId,totalCostMinor:value.totalCostMinor,unitCostMinor:value.row.parsed.unitCostMinor,
          journalEntryId:value.totalCostMinor>0?posted[journalIndex++].entry.id:null,sourceType:'opening_inventory',sourceRecordId:value.row.id})));
        pendingValues=[];
      }
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
        for(let chunkStart=0;chunkStart<group.length;chunkStart+=500){
        const chunk=group.slice(chunkStart,chunkStart+500),receiving=chunk.filter(row=>row.parsed.quantity>0);
        const newPrices=[];
        for(const row of chunk){if(row.parsed.sellingPriceMinor===null)continue;
          const skuId=row.parsed.existingSkuId||skuByVariant.get(key.startsWith('existing:')?'existing':variantKey(row.parsed)),saleKey=`${row.parsed.currency}:${row.parsed.sellingPriceMinor}`;
          if(salePriceBySku.has(skuId)&&salePriceBySku.get(skuId)!==saleKey)throw new ValidationError(`Conflicting selling prices for ${row.parsed.name} in this import.`);
          if(!salePriceBySku.has(skuId)){newPrices.push({skuId,amountMinor:row.parsed.sellingPriceMinor,currency:row.parsed.currency,source:'opening_import',sourceDetail:{importId:id,importRowId:row.id}});salePriceBySku.set(skuId,saleKey);}
        }
        await postgresPrices.setPricesInTransaction(client,ctx,newPrices);
        const receivedRows=await inventory.receiveManyInTransaction(client,ctx,receiving.map(row=>({
          skuId:row.parsed.existingSkuId||skuByVariant.get(key.startsWith('existing:')?'existing':variantKey(row.parsed)),locationId:row.parsed.locationId,quantity:row.parsed.quantity,
          serials:row.parsed.serial?[row.parsed.serial]:undefined,lotCode:row.parsed.lotCode,expiresAt:row.parsed.expiresAt,lotReceivedAt:row.parsed.receivedAt,
          notes:row.parsed.notes,reference:`Import ${plan.sourceName} row ${row.rowNumber}`,idempotencyKey:`import:${id}:row:${row.id}`})));
        const receiptByRow=new Map(receiving.map((row,index)=>[row.id,receivedRows[index]]));
        for(const row of chunk){
          if(options.beforeRow)await options.beforeRow({row,rowsImported});
          const skuId=row.parsed.existingSkuId || skuByVariant.get(key.startsWith('existing:')?'existing':variantKey(row.parsed));
          const itemId=row.parsed.existingItemId || row.parsed.createdItemId;
          const movementIds=[];
          if(row.parsed.quantity>0){
            const received=receiptByRow.get(row.id);
            movementIds.push(received.movementId);units+=row.parsed.quantity;
            if(row.parsed.unitCostMinor!==null){
              const totalCostMinor=row.parsed.quantity*row.parsed.unitCostMinor;
              pendingValues.push({row,skuId,movementId:received.movementId,totalCostMinor,postingDate:nowIso().slice(0,10)});
              if(pendingValues.length>=500)await flushValues();
            }
          }
          savedRows.push({id:row.id,itemId,skuId,locationId:row.parsed.locationId,movementIds,quantity:row.parsed.quantity,at:nowIso()});
          if(savedRows.length>=500){await rowStore.markImported(client,ctx.workspaceId,id,savedRows);savedRows=[];}
          rowsImported+=1;
          if(!pendingValues.length)publishProgress('processing',rowsImported);
        }
        await flushValues();publishProgress('processing',rowsImported);
        }
      }
      await flushValues();
      await rowStore.markImported(client,ctx.workspaceId,id,savedRows);
      publishProgress('verifying',rowsImported);
      const checks=[{name:'Rows imported',expected:sourceRows.length,observed:rowsImported,ok:sourceRows.length===rowsImported},
        {name:'Opening units',expected:sourceRows.reduce((sum,row)=>sum+(row.parsed.quantity || 0),0),observed:units,
          ok:sourceRows.reduce((sum,row)=>sum+(row.parsed.quantity || 0),0)===units}];
      const valuedRows=sourceRows.filter((row)=>row.parsed.quantity>0&&row.parsed.unitCostMinor!==null);
      const expectedValue=valuedRows.reduce((sum,row)=>sum+row.parsed.quantity*row.parsed.unitCostMinor,0);
      // Fresh bulk writes are invisible to the statistics collector. An estimate
      // of one new entry can otherwise rescan every journal line for each entry.
      // Use linear joins for this bulk read only; restore the connection setting
      // after success. A failed transaction automatically restores LOCAL settings.
      const verificationJoinSetting=valuedRows.length>=500
        ?(await client.query("SELECT current_setting('enable_nestloop') AS enabled")).rows[0].enabled:null;
      if(verificationJoinSetting!==null)await client.query("SELECT set_config('enable_nestloop','off',true)");
      const value=(await client.query(`SELECT COALESCE(SUM(c.cost_delta_minor),0)::bigint AS value,
        COUNT(*)::int AS movements FROM accounting_inventory_cost_movements c
        JOIN import_rows r ON r.id=c.cost_source_record_id AND r.workspace_id=c.workspace_id
        WHERE c.workspace_id=$1 AND c.cost_source_type='opening_inventory' AND r.import_id=$2`,
      [ctx.workspaceId,id])).rows[0];
      const posted=(await client.query(`SELECT COALESCE(SUM(l.debit_minor),0)::bigint AS value
        FROM accounting_journal_entries e JOIN accounting_journal_lines l
          ON l.entry_id=e.id AND l.workspace_id=e.workspace_id
        JOIN accounting_accounts a ON a.id=l.account_id AND a.workspace_id=l.workspace_id
        JOIN import_rows r ON r.id=e.source_record_id AND r.workspace_id=e.workspace_id
        WHERE e.workspace_id=$1 AND e.source_type='opening_inventory'
          AND e.source_record_type='import_row' AND r.import_id=$2 AND a.system_key='INVENTORY_ASSET'`,
      [ctx.workspaceId,id])).rows[0];
      if(verificationJoinSetting!==null)await client.query("SELECT set_config('enable_nestloop',$1,true)",[verificationJoinSetting]);
      checks.push({name:'Valued receipt records',expected:valuedRows.length,observed:Number(value.movements),
        ok:valuedRows.length===Number(value.movements)},
      {name:'Opening cost in cents',expected:expectedValue,observed:Number(value.value),
        ok:expectedValue===Number(value.value)},
      {name:'Inventory asset posted in cents',expected:expectedValue,observed:Number(posted.value),
        ok:expectedValue===Number(posted.value)});
      const verified=checks.every((check)=>check.ok);
      if(!verified)throw new ValidationError('The imported stock and accounting evidence did not reconcile. No changes from this attempt were saved.',{checks});
      const finishedAt=nowIso();
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
      await options.beforeCommit?.();
      return {executionId,verificationId,verified,checks,itemsCreated,skusCreated,rowsImported,units};
    },{isolation:'SERIALIZABLE',retrySafe:true});
  } catch(error) {
    await database.query(`UPDATE import_executions SET status='FAILED',stage='rolled_back',error_message=$2,finished_at=$3,
      result=COALESCE($4,result) WHERE id=$1`,[executionId,String(error.message).slice(0,1000),nowIso(),
      error.details?.checks?JSON.stringify({failedChecks:error.details.checks}):null]);
    await database.query(`UPDATE import_plans SET status='READY' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    throw error;
  }
  // Business writes have committed. Keep all advisory work outside the rollback
  // handler so maintenance failures cannot rewrite saved business truth.
  const committedAt=nowIso();let commitReceiptPersisted=true;
  try{await database.query('UPDATE import_executions SET committed_at=$3 WHERE workspace_id=$1 AND id=$2 AND status=\'SUCCEEDED\'',[ctx.workspaceId,result.executionId,committedAt]);}
  catch{commitReceiptPersisted=false;}
  let statistics;
  try{statistics=await require('./postgres-statistics').refreshAfterImport(database,result);}
  catch(error){statistics={state:'DEFERRED',reason:error.code||error.name};}
  return {...result,committedAt,commitReceiptPersisted,statistics};
}

async function queueExecution(database,ctx,id,expectedHash){
  await assertOperator(database,ctx);
  return database.transaction(async client=>{
    const plan=hydratePlan((await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0]);
    if(!plan)throw new NotFoundError('That import could not be found.');
    if(plan.status!=='READY'||plan.approvalStatus!=='APPROVED'||plan.integrityHash!==expectedHash)
      throw new ValidationError('Review and approve the current preview before starting this import.');
    const scoped={query:(sql,values)=>client.query(sql,values),transaction:fn=>fn(client)};
    return require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId:ctx.workspaceId,
      kind:'import.execute-approved',idempotencyKey:`ask-import:${id}:${expectedHash}`,
      payload:{planId:id,actorId:ctx.actorId,integrityHash:expectedHash},priority:30,maxAttempts:1});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function requireRolledBackExecution(database,ctx,plan,executionId){
  const failed=(await database.query(`SELECT id FROM import_executions WHERE workspace_id=$1 AND import_id=$2
    AND id=$3 AND status='FAILED' AND stage='rolled_back'`,[ctx.workspaceId,plan.id,executionId])).rows[0];
  if(!failed||plan.status!=='READY'||plan.approvalStatus!=='APPROVED')throw new ValidationError('Only a fully rolled-back import with its unchanged approval can be retried.');
  const unsafe=(await database.query(`SELECT EXISTS(SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED') OR
    EXISTS(SELECT 1 FROM import_executions WHERE workspace_id=$1 AND import_id=$2 AND status IN ('EXECUTING','SUCCEEDED')) AS found`,[ctx.workspaceId,plan.id])).rows[0];
  if(unsafe.found)throw new ValidationError('This import has active or saved effects. Review its existing result before continuing.');
  return failed;
}

async function retryExecution(database,ctx,id,expectedHash,executionId){
  await assertOperator(database,ctx);
  return database.transaction(async client=>{
    const row=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row)throw new NotFoundError('That import could not be found.');
    const plan=hydratePlan(row);if(plan.integrityHash!==expectedHash||plan.isExpired)throw new ValidationError('Review the current import preview before retrying.');
    await requireRolledBackExecution(client,ctx,plan,executionId);
    const scoped={query:(sql,values)=>client.query(sql,values),transaction:fn=>fn(client)};
    return require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId:ctx.workspaceId,
      kind:'import.execute-approved',idempotencyKey:`retry-import:${id}:${expectedHash}:${executionId}`,
      payload:{planId:id,actorId:ctx.actorId,integrityHash:expectedHash,retryExecutionId:executionId},priority:30,maxAttempts:1});
  },{isolation:'SERIALIZABLE',retrySafe:true});
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

module.exports={analyse,get,list,rowsFor,counts,duplicates,revise,approve,execute,queueExecution,retryExecution,report,cancel,hydratePlan,hydrateRow};
require('../commercial/enforcement').guardExports(module.exports,0,1,{analyse:'imports.spreadsheet',approve:'imports.spreadsheet',
  revise:'imports.spreadsheet',execute:'imports.spreadsheet',queueExecution:'imports.spreadsheet',retryExecution:'imports.spreadsheet',cancel:'imports.spreadsheet'});
