'use strict';
const {ValidationError}=require('../domain/errors'),{newId,nowIso}=require('../lib/util'),catalog=require('../domain/postgres-catalog-service'),inventory=require('../domain/postgres-inventory-engine'),costing=require('../accounting/postgres-costing'),postgresPrices=require('../pricing/postgres-service'),commerce=require('../operations/postgres-commerce'),plannedLocations=require('./planned-locations'),rowStore=require('./postgres-row-store'),verification=require('./postgres-verification');
const key=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
const exact=require('../domain/exact-quantity');
const addExact=(a,b)=>exact.safeNumber(exact.add(a,b),{signed:true});
async function run(database,ctx,plan,executionId,inputOptions,deps){
 const id=plan.id,options=inputOptions,identities=require('./postgres-execution-identities'),batchSize=plan.recordsValid>=5000&&plan.transformations.importMode!=='set'?2000:500;let checkpoint,attemptStartRows=null;const attemptStartedAt=Date.now();
 const emit=(stage,preparedRows)=>inputOptions.onProgress?.({stage,processedRows:Number(checkpoint?.savedRows||0),totalRows:plan.recordsValid,attempt:1,durable:true,elapsedMs:Date.now()-attemptStartedAt,attemptStartRows:attemptStartRows??Number(checkpoint?.savedRows||0),...(preparedRows===undefined?{}:{preparedRows}),...(Number.isSafeInteger(checkpoint?.skusPlanned)?{preparedTotal:checkpoint.skusPlanned}:{})});
 async function phase(operation){return database.transaction(async client=>{
  const locked=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(!locked||locked.approval_status!=='APPROVED'||locked.integrity_hash!==plan.integrityHash)throw new ValidationError('The approved import changed. Its saved batches remain recorded.');
  await deps.assertOperator(client,ctx);await deps.assertSourceClaim(client,ctx,plan);await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'imports.spreadsheet');await deps.bulkPlanning(client);
  const saved=locked.apply_checkpoint||{};if(saved.hash&&saved.hash!==plan.integrityHash)throw new ValidationError('Saved import progress belongs to another approval.');
  const result=await operation(client,saved);await inputOptions.beforeBatchCommit?.();return result;
 },{isolation:'READ COMMITTED',retrySafe:true});}
 async function save(client,value){const next={...value,hash:plan.integrityHash,updatedAt:nowIso()};await client.query('UPDATE import_plans SET apply_checkpoint=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,JSON.stringify(next)]);return next;}
 do {checkpoint=await phase(async(client,saved)=>{
  await identities.stage(client,ctx,plan,deps,prepared=>inputOptions.onProgress?.({stage:'preparing',processedRows:Number(saved.savedRows||0),preparedRows:prepared,totalRows:plan.recordsValid,attempt:1,durable:true,elapsedMs:Date.now()-attemptStartedAt}));
  const imported=saved.catalogueStarted&&!saved.cataloguePrepared?0:Number((await client.query("SELECT count(*) n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,id])).rows[0].n);
  if(saved.cataloguePrepared){if(Number(saved.savedRows)!==imported)throw new ValidationError('Saved import progress does not match its recorded rows. Its existing records remain safe.');return saved;}
  if(!saved.catalogueStatsPrepared&&plan.recordsValid>=5000){await client.query('ANALYZE import_execution_identities (workspace_id,import_id,row_id,row_number,product_key,variant_key,existing_sku_id,existing_item_id), import_rows (id,workspace_id,import_id,row_number,status,item_id,sku_id,location_id)');saved.catalogueStatsPrepared=true;}
  if(imported)throw new ValidationError('This import has saved records without a matching execution checkpoint. Review its saved result.');
  // New SKUs are what preparing creates; progress is shown against them.
  if(!saved.catalogueStarted){const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),capacity=await identities.counts(client,ctx,plan);saved.skusPlanned=capacity.skus;
   await entitlements.assertMeterCapacity(client,scope,'active_skus',capacity.skus);}
  const locations=saved.locations||Object.fromEntries(await plannedLocations.materialize(client,ctx,plan.transformations.proposedLocations||[]));
  const created=await require('./postgres-prepare-catalogue').prepare(client,ctx,plan,options,deps,saved);
  if(created.cataloguePrepared&&plan.recordsValid>=5000)await client.query('ANALYZE skus (id,workspace_id,item_id,is_active), items (id,workspace_id,is_active), import_catalogue_bindings (workspace_id,import_id,product_key,variant_key,item_id,sku_id)');
  // Pin the order before saving any stock. Earlier partially prepared plans
  // retain their source order; a resumed plan never changes its page cursor.
  let executionOrder=saved.executionOrder||'source';
  if(!saved.executionOrder&&!saved.catalogueStarted&&plan.recordsValid>=5000&&plan.transformations.importMode==='add'&&plan.fieldMappings.quantity!==undefined){
   // A category shared by several variants must keep its source-file winner.
   // Conflicting parent updates and older unclassified caches stay in source
   // order; ordinary stock and consistent categories can use SKU locality.
   const unsafe=(await client.query(`SELECT EXISTS(SELECT 1 FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND source_category IS NULL)
    OR EXISTS(SELECT 1 FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND source_category<>''
     GROUP BY coalesce(existing_item_id,product_key) HAVING count(DISTINCT source_category)>1) AS unsafe`,[ctx.workspaceId,id])).rows[0].unsafe;
   if(!unsafe)executionOrder='sku';
  }
  return save(client,{...saved,version:3,executionOrder,catalogueStarted:true,initialPricesPrepared:true,locations,postingDate:saved.postingDate||await require('../lib/business-time').today(client,ctx.workspaceId),...created,savedRows:0,units:0});
 });await emit('preparing',checkpoint.skusCreated);
 }while(!checkpoint.cataloguePrepared);
 attemptStartRows=Number(checkpoint.savedRows||0);
 await emit('preparing',plan.recordsValid);

 const settingCounts=plan.transformations.importMode==='set',isCount=row=>settingCounts&&row.parsed.existingSkuId&&row.parsed.quantity!==null,expectedDelta=row=>isCount(row)?row.parsed.countQuantityDelta:(row.parsed.quantity||0),expectedCost=row=>isCount(row)?row.parsed.countCostDeltaMinor:exact.costMinor(row.parsed.quantity||0,row.parsed.unitCostMinor||0),expectsCostRecord=row=>isCount(row)?expectedDelta(row)>0&&row.parsed.unitCostMinor!==null||expectedDelta(row)<0&&row.parsed.inventoryBefore.costed>0:row.parsed.quantity>0&&row.parsed.unitCostMinor!==null;
 for await(const chunk of rowStore.executionPages(database,ctx.workspaceId,id,{batchSize,orderBySku:checkpoint.executionOrder==='sku',cursor:checkpoint.executionCursor})){
  await identities.hydrate(database,ctx,plan,chunk,checkpoint);const priorSaved=Number(checkpoint.savedRows||0);
  await emit('processing');
  const result=await phase(async(client,saved)=>{
   const sourceRows=chunk,options={...inputOptions,beforeRow:value=>inputOptions.beforeRow?.({...value,rowsImported:priorSaved+value.rowsImported})},publishProgress=()=>{};
   const salePriceBySku=new Map();
   for(const row of chunk)if(!row.parsed.existingSkuId&&checkpoint.initialPricesPrepared&&row.parsed.sellingPriceMinor!==null)salePriceBySku.set(row.parsed.createdSkuId,row.parsed.currency+':'+row.parsed.sellingPriceMinor);
   const pricedExisting=[...new Set(chunk.filter(r=>r.parsed.existingSkuId&&r.parsed.sellingPriceMinor!==null).map(r=>r.parsed.existingSkuId))];
   const priorPrices=pricedExisting.length?(await client.query("SELECT DISTINCT e.existing_sku_id AS sku_id,e.currency,e.selling_price_minor AS amount FROM import_execution_identities e JOIN import_rows r ON r.id=e.row_id AND r.workspace_id=e.workspace_id AND r.import_id=e.import_id WHERE e.workspace_id=$1 AND e.import_id=$2 AND e.existing_sku_id=ANY($3::text[]) AND e.selling_price_minor IS NOT NULL AND r.status='IMPORTED'",[ctx.workspaceId,id,pricedExisting])).rows:[];
   for(const row of priorPrices)salePriceBySku.set(row.sku_id,row.currency+':'+row.amount);
   let savedRows=[],pendingValues=[],units=0,rowsImported=0;
      async function flushValues(){
        if(!pendingValues.length)return;
        const journalByRow=await require('./postgres-opening-values').post(client,ctx,plan,pendingValues);
        await costing.receiveManyInTransaction(client,ctx,pendingValues.map(value=>({movementId:value.movementId,totalCostMinor:value.totalCostMinor,unitCostMinor:value.row.parsed.unitCostMinor,
          journalEntryId:journalByRow.get(value.row.id)||null,sourceType:value.count?'import_stock_count':'opening_inventory',sourceRecordId:value.row.id})));
        pendingValues=[];
      }

      // Batch across product boundaries. Per-product chunks turn a large flat
      // catalogue into thousands of single-row stock/accounting round trips.
      for(let chunkStart=0;chunkStart<sourceRows.length;chunkStart+=batchSize){
        const chunk=sourceRows.slice(chunkStart,chunkStart+batchSize),receiving=chunk.filter(row=>isCount(row)?expectedDelta(row)>0:row.parsed.quantity>0);
        const countPositions=receiving.filter(isCount).map(row=>({sku_id:row.parsed.existingSkuId,location_id:row.parsed.locationId}));
        const priorCountHistory=countPositions.length?(await client.query(`SELECT p.sku_id,p.location_id FROM jsonb_to_recordset($2::jsonb) p(sku_id text,location_id text)
          WHERE EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=$1 AND m.sku_id=p.sku_id AND m.location_id=p.location_id AND m.occurred_at<=$3)`,[ctx.workspaceId,JSON.stringify(countPositions),plan.createdAt])).rows:[];
        const historic=new Set(priorCountHistory.map(p=>JSON.stringify([p.sku_id,p.location_id])));
        const newPrices=[],initialPrices=[];
        for(const row of chunk){if(row.parsed.sellingPriceMinor===null)continue;
          const skuId=row.parsed.existingSkuId||row.parsed.createdSkuId,saleKey=`${row.parsed.currency}:${row.parsed.sellingPriceMinor}`;
          if(salePriceBySku.has(skuId)&&salePriceBySku.get(skuId)!==saleKey)throw new ValidationError(`Conflicting selling prices for ${row.parsed.name} in this import.`);
          if(!salePriceBySku.has(skuId)){(row.parsed.existingSkuId?newPrices:initialPrices).push({skuId,amountMinor:row.parsed.sellingPriceMinor,currency:row.parsed.currency,source:'opening_import',...(Object.hasOwn(row.parsed,'currentPriceId')?{expectedCurrentId:row.parsed.currentPriceId}:{}),sourceDetail:{importId:id,importRowId:row.id}});salePriceBySku.set(skuId,saleKey);}
        }
        await require('./postgres-barcodes').apply(client,ctx,chunk);
        const catalogueCosts=chunk.filter(row=>row.parsed.unitCostMinor!==null&&(row.parsed.quantity===null||row.parsed.quantity===0)).map(row=>({skuId:row.parsed.existingSkuId||row.parsed.createdSkuId,amountMinor:row.parsed.unitCostMinor,currency:row.parsed.currency,source:'catalogue_import',sourceDetail:{importId:id,importRowId:row.id}}));
        if(catalogueCosts.length)await postgresPrices.setPurchaseCostsInTransaction(client,ctx,catalogueCosts);
        if(newPrices.length)await postgresPrices.setPricesInTransaction(client,ctx,newPrices);
        if(initialPrices.length)await postgresPrices.setPricesInTransaction(client,ctx,initialPrices,{initialize:true});
        const receivedRows=await inventory.receiveManyInTransaction(client,ctx,receiving.map(row=>({
          skuId:row.parsed.existingSkuId||row.parsed.createdSkuId,locationId:row.parsed.locationId,quantity:expectedDelta(row),
          serials:row.parsed.serial?[row.parsed.serial]:undefined,lotCode:row.parsed.lotCode,expiresAt:row.parsed.expiresAt,lotReceivedAt:row.parsed.receivedAt,
          notes:row.parsed.notes,reference:`Import ${plan.sourceName} row ${row.rowNumber}`,idempotencyKey:`import:${id}:row:${row.id}`})));
        const receiptByRow=new Map(receiving.map((row,index)=>[row.id,receivedRows[index]]));
        const countedByRow=new Map();
        for(const row of chunk.filter(row=>isCount(row)&&expectedDelta(row)<0)){
          const value=await require('../accounting/postgres-physical-count').applyInTransaction(client,ctx,{
            skuId:row.parsed.existingSkuId,locationId:row.parsed.locationId,countedQuantity:row.parsed.quantity,
            expectedBefore:row.parsed.inventoryBefore,preservePostPreviewMovements:true,expectedCostDeltaMinor:row.parsed.countCostDeltaMinor,
            unitCostMinor:row.parsed.unitCostMinor,currency:row.parsed.currency,reasonCode:'file_physical_count',
            description:'Physical count from '+plan.sourceName,reference:'Import '+id+' row '+row.rowNumber,
            sourceType:'import_stock_count',sourceRecordType:'import_row',sourceRecordId:row.id,
            idempotencyKey:'import:'+id+':row:'+row.id+':set'});
          countedByRow.set(row.id,value);
        }
        for(const row of chunk){
          if(options.beforeRow)await options.beforeRow({row,rowsImported});
          const skuId=row.parsed.existingSkuId || row.parsed.createdSkuId;
          const itemId=row.parsed.existingItemId || row.parsed.createdItemId;
          const movementIds=[];
          if(isCount(row)&&expectedDelta(row)<=0){
            const counted=countedByRow.get(row.id);if(counted?.movementId)movementIds.push(counted.movementId);units=addExact(units,expectedDelta(row));
          }else if(expectedDelta(row)>0){
            const received=receiptByRow.get(row.id);
            movementIds.push(received.movementId);units=addExact(units,expectedDelta(row));
            if(row.parsed.unitCostMinor!==null){
              const totalCostMinor=exact.costMinor(expectedDelta(row),row.parsed.unitCostMinor);
              pendingValues.push({row,skuId,movementId:received.movementId,totalCostMinor,postingDate:checkpoint.postingDate,count:isCount(row),opening:row.parsed.inventoryBefore?.physical===0&&row.parsed.inventoryBefore?.costed===0&&(row.parsed.inventoryBefore.hasHistory===false||row.parsed.inventoryBefore.hasHistory===undefined&&!historic.has(JSON.stringify([skuId,row.parsed.locationId])))});
              if(pendingValues.length>=batchSize)await flushValues();
            }
          }
          savedRows.push({id:row.id,itemId,skuId,locationId:row.parsed.locationId,movementIds,quantity:row.parsed.quantity,at:nowIso()});
          if(savedRows.length>=batchSize){await rowStore.markImported(client,ctx.workspaceId,id,savedRows);savedRows=[];}
          rowsImported+=1;
          if(!pendingValues.length)publishProgress('processing',rowsImported);
        }
        await flushValues();publishProgress('processing',rowsImported);
      }
      await flushValues();
      await rowStore.markImported(client,ctx.workspaceId,id,savedRows);

      const suppliersByName=new Map();
      for(let start=0;start<sourceRows.length;start+=500){
        const chunk=sourceRows.slice(start,start+500),facts=[],policies=[],supplierLinks=[];
        for(const row of chunk){const p=row.parsed,skuId=p.existingSkuId||p.createdSkuId;
          for(const [name,value]of Object.entries(p.sourceFacts||{}))facts.push({skuId,locationId:p.locationId,name,value,importId:id,rowNumber:row.rowNumber});
          if(Object.keys(p.reorder||{}).some(key=>key!=='leadTimeDays'||!p.supplierName))policies.push({skuId,locationId:p.locationId,...p.reorder,...(p.supplierName?{leadTimeDays:undefined}:{}),source:'manual',notes:'Approved file import '+id+', row '+row.rowNumber});
          if(p.supplierName){const name=p.supplierName.toLowerCase();let supplierId=suppliersByName.get(name);
            if(!supplierId){const existing=(await client.query("SELECT id,status FROM suppliers WHERE workspace_id=$1 AND lower(name)=lower($2)",[ctx.workspaceId,p.supplierName])).rows;
              if(existing.length>1||existing[0]&&existing[0].status!=='active')throw new ValidationError('The source supplier is ambiguous or archived. Review its saved record before importing.');
              supplierId=existing[0]?.id||(await commerce.createSupplierInTransaction(client,ctx,{name:p.supplierName,currency:p.currency},{reuseExisting:true})).id;suppliersByName.set(name,supplierId);}
            supplierLinks.push({supplierId,skuId,...(p.unitCostMinor==null?{}:{lastUnitCost:require('../domain/currency').fromMinor(p.unitCostMinor,p.currency)}),...(p.reorder?.leadTimeDays===undefined?{}:{leadTimeDays:p.reorder.leadTimeDays})});
          }
        }
        const categories=new Map();for(const row of chunk){const p=row.parsed,category=p.sourceFacts?.Category;if(category)categories.set(p.existingItemId||p.createdItemId,{item_id:p.existingItemId||p.createdItemId,category});}
        if(categories.size)await client.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at)
          SELECT $1,x.item_id,x.category,'{}',$3,$3 FROM jsonb_to_recordset($2::jsonb) x(item_id text,category text)
          ON CONFLICT(workspace_id,item_id) DO UPDATE SET category=EXCLUDED.category,updated_at=EXCLUDED.updated_at`,[ctx.workspaceId,JSON.stringify([...categories.values()]),nowIso()]);
        if(supplierLinks.length)await commerce.linkSupplierItemsInTransaction(client,ctx,supplierLinks);
        if(facts.length)await require('../domain/postgres-catalog-facts').saveManyInTransaction(client,ctx,facts);
        if(policies.length)await require('../operations/postgres-reorder-policies').setManyInTransaction(client,ctx,policies);
      }

   const totals=await verification.totals(client,ctx.workspaceId,chunk.map(row=>row.id)),value=chunk.reduce((n,row)=>addExact(n,expectedCost(row)),0),expectedUnits=chunk.reduce((n,row)=>addExact(n,expectedDelta(row)),0),valued=chunk.filter(expectsCostRecord).length;
   const checks=[{name:'Rows saved',expected:chunk.length,observed:rowsImported,ok:rowsImported===chunk.length},{name:'Stock movement units',expected:expectedUnits,observed:units,ok:units===expectedUnits},{name:'Cost records',expected:valued,observed:totals.value.movements,ok:valued===totals.value.movements},{name:'Inventory cost',expected:value,observed:Number(totals.value.value),ok:value===Number(totals.value.value)},{name:'Inventory asset',expected:value,observed:Number(totals.posted.value),ok:value===Number(totals.posted.value)}];
   if(!checks.every(check=>check.ok))throw new ValidationError('The imported stock and accounting evidence did not reconcile. The current batch was not saved.',{checks});
   const next=await save(client,{...saved,...(saved.executionOrder==='sku'?{executionCursor:chunk.at(-1).executionCursor}:{}),savedRows:priorSaved+chunk.length,units:addExact(saved.units||0,units),lastBatch:{executionId,firstRow:Math.min(...chunk.map(r=>r.rowNumber)),lastRow:Math.max(...chunk.map(r=>r.rowNumber)),checks}});
   await client.query('UPDATE import_executions SET items_created=$3,skus_created=$4,rows_imported=$5,units_established=$6,stage=$7 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,executionId,next.itemsCreated,next.skusCreated,next.savedRows,next.units,'processing']);
   return {checkpoint:next,prices:[...salePriceBySku]};
  });
  checkpoint=result.checkpoint;await emit('processing');
 }
 await emit('verifying');
 const totals={value:{value:0n,movements:0},posted:{value:0n}};let expectedUnits=0,expectedValue=0,valued=0;
 await database.transaction(async client=>{
  await deps.bulkPlanning(client);
  for await(const page of rowStore.executionPages(client,ctx.workspaceId,id,{includeImported:true,lock:false,batchSize})){
   const observed=await verification.totals(client,ctx.workspaceId,page.map(r=>r.id));
   totals.value.value+=BigInt(observed.value.value);totals.value.movements+=observed.value.movements;totals.posted.value+=BigInt(observed.posted.value);
   for(const row of page){expectedUnits=addExact(expectedUnits,expectedDelta(row));expectedValue=addExact(expectedValue,expectedCost(row));if(expectsCostRecord(row))valued++;}
  }
 },{isolation:'REPEATABLE READ',readOnly:true});
 const checks=[{name:'Rows imported',expected:plan.recordsValid,observed:checkpoint.savedRows,ok:checkpoint.savedRows===plan.recordsValid},{name:'Net stock change',expected:expectedUnits,observed:checkpoint.units,ok:checkpoint.units===expectedUnits},{name:'Valued receipt records',expected:valued,observed:totals.value.movements,ok:valued===totals.value.movements},{name:'Inventory cost change in minor units',expected:expectedValue,observed:Number(totals.value.value),ok:expectedValue===Number(totals.value.value)},{name:'Inventory asset posted in minor units',expected:expectedValue,observed:Number(totals.posted.value),ok:expectedValue===Number(totals.posted.value)}];
 if(!checks.every(check=>check.ok))throw new ValidationError('Saved import records need reconciliation. Verified batches remain recorded.',{checks});
 return phase(async client=>{const count=Number((await client.query("SELECT count(*) n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,id])).rows[0].n);if(count!==plan.recordsValid)throw new ValidationError('Some approved rows remain unsaved. Continue the import.');
  const at=nowIso(),verificationId=newId('impverify'),observed={itemsCreated:checkpoint.itemsCreated,itemsUpdated:checkpoint.itemsUpdated,skusCreated:checkpoint.skusCreated,rowsImported:count,units:checkpoint.units};
  await client.query("INSERT INTO import_verifications(id,workspace_id,import_id,execution_id,verified,checks,observed,problems,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'[]',$7)",[verificationId,ctx.workspaceId,id,executionId,JSON.stringify(checks),JSON.stringify(observed),at]);
  await client.query("UPDATE import_executions SET status='SUCCEEDED',stage='verified',items_created=$3,skus_created=$4,rows_imported=$5,units_established=$6,result=$7,finished_at=$8 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,executionId,checkpoint.itemsCreated,checkpoint.skusCreated,count,checkpoint.units,JSON.stringify({verificationId,verified:true,checks,durable:true}),at]);
  await save(client,{...checkpoint,complete:true});await client.query("UPDATE import_plans SET status='SUCCEEDED',completed_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,at]);await require('../commercial/storage-capacity').finish(client,ctx.workspaceId,'import:'+id);await inputOptions.beforeCommit?.();return {...observed,executionId,verificationId,verified:true,checks,durable:true};
 });
}
module.exports={run};
