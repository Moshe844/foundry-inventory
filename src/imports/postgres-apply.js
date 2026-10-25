'use strict';
const {ValidationError}=require('../domain/errors'),{newId,nowIso}=require('../lib/util'),catalog=require('../domain/postgres-catalog-service'),inventory=require('../domain/postgres-inventory-engine'),ledger=require('../accounting/postgres-ledger'),costing=require('../accounting/postgres-costing'),postgresPrices=require('../pricing/postgres-service'),commerce=require('../operations/postgres-commerce'),plannedLocations=require('./planned-locations'),rowStore=require('./postgres-row-store'),verification=require('./postgres-verification');
const key=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
async function run(database,ctx,plan,executionId,inputOptions,deps){
 const id=plan.id,options=inputOptions;let sourceRows,checkpoint;
 const emit=(stage,preparedRows)=>inputOptions.onProgress?.({stage,processedRows:Number(checkpoint?.savedRows||0),totalRows:plan.recordsValid,attempt:1,durable:true,...(preparedRows===undefined?{}:{preparedRows})});
 async function phase(operation){return database.transaction(async client=>{
  const locked=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(!locked||locked.approval_status!=='APPROVED'||locked.integrity_hash!==plan.integrityHash)throw new ValidationError('The approved import changed. Its saved batches remain recorded.');
  await deps.assertOperator(client,ctx);await deps.assertSourceClaim(client,ctx,plan);await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'imports.spreadsheet');await deps.bulkPlanning(client);
  const saved=locked.apply_checkpoint||{};if(saved.hash&&saved.hash!==plan.integrityHash)throw new ValidationError('Saved import progress belongs to another approval.');
  const result=await operation(client,saved);await inputOptions.beforeBatchCommit?.();return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});}
 async function save(client,value){const next={...value,hash:plan.integrityHash,updatedAt:nowIso()};await client.query('UPDATE import_plans SET apply_checkpoint=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,JSON.stringify(next)]);return next;}
 checkpoint=await phase(async(client,saved)=>{
  sourceRows=await rowStore.executionRows(client,ctx.workspaceId,id,prepared=>inputOptions.onProgress?.({stage:'preparing',processedRows:Number(saved.savedRows||0),preparedRows:prepared,totalRows:plan.recordsValid,attempt:1,durable:true}),{includeImported:true});
  if(sourceRows.length!==plan.recordsValid)throw new ValidationError('The frozen approved row count changed.');
  if(saved.cataloguePrepared&&Number(saved.savedRows)!==sourceRows.filter(row=>row.imported).length)throw new ValidationError('Saved import progress does not match its recorded rows. Its existing records remain safe.');
  if(saved.cataloguePrepared){const bindings=(await client.query('SELECT product_key,variant_key,item_id,sku_id FROM import_catalogue_bindings WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,id])).rows,map=new Map(bindings.map(row=>[row.product_key+':'+row.variant_key,row])),locations=new Map(Object.entries(saved.locations||{}));for(const row of sourceRows){const p=row.parsed;if(!p.existingSkuId){const found=map.get(key(deps.productKey(p))+':'+key(deps.variantKey(p)));if(!found)throw new ValidationError('A prepared imported product is missing. Saved stock remains recorded.');p.createdSkuId=found.sku_id;p.createdItemId=found.item_id;}if(p.proposedLocationName){p.locationId=locations.get(p.proposedLocationName);if(!p.locationId)throw new ValidationError('A prepared source location is missing.');}}return saved;}
  if(sourceRows.some(row=>row.imported))throw new ValidationError('This import has saved records without a matching execution checkpoint. Review its saved result.');
  const newLocations=await plannedLocations.materialize(client,ctx,plan.transformations.proposedLocations||[]);
  for(const row of sourceRows)if(row.parsed.proposedLocationName){const locationId=newLocations.get(row.parsed.proposedLocationName);if(!locationId)throw new ValidationError('An approved location could not be prepared.');row.parsed={...row.parsed,locationId};}
  const grouped=new Map();for(const row of sourceRows){const key=deps.productKey(row.parsed);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
  const catalogueUpdates=new Map();for(const row of sourceRows){const update=row.parsed.catalogueUpdate;if(!update)continue;const prior=catalogueUpdates.get(update.itemId);if(prior&&prior.name!==update.name)throw new ValidationError('One product has conflicting source names.');catalogueUpdates.set(update.itemId,update);}
  await catalog.updateImportedNamesInTransaction(client,ctx,[...catalogueUpdates.values()]);
  let itemsCreated=0,skusCreated=0;const productKey=deps.productKey,variantKey=deps.variantKey;
      const fresh=[...grouped].filter(([key])=>!key.startsWith('existing:'));
      for(let offset=0;offset<fresh.length;offset+=500){
        const batch=fresh.slice(offset,offset+500),definitions=[];
        for(const [key,group]of batch){
          if(options.beforeGroup)await options.beforeGroup({key,group,itemsCreated});
          const seen=new Set(),distinct=[];
          for(const row of group){const v=variantKey(row.parsed);if(seen.has(v))continue;seen.add(v);distinct.push({key:v,code:row.parsed.code,barcode:row.parsed.barcode,options:row.parsed.variants});}
          const first=group[0].parsed;definitions.push({name:first.name,description:first.description,unitLabel:first.unitLabel,trackingMode:first.trackingMode,variants:distinct});
        }
        const results=await catalog.createImportedItemsInTransaction(client,ctx,definitions);
        for(let i=0;i<batch.length;i++){const group=batch[i][1],created=results[i],byVariant=new Map(created.skus.map(sku=>[sku.key,sku.skuId]));itemsCreated++;skusCreated+=created.skus.length;
          for(const row of group){row.parsed.createdItemId=created.itemId;row.parsed.createdSkuId=byVariant.get(variantKey(row.parsed));}}
      }

  const initialPrices=new Map(),seenPrices=new Map();for(const row of sourceRows){const p=row.parsed;if(p.sellingPriceMinor===null)continue;const skuId=p.existingSkuId||p.createdSkuId,key=p.currency+':'+p.sellingPriceMinor;if(seenPrices.has(skuId)&&seenPrices.get(skuId)!==key)throw new ValidationError('One imported variant has conflicting selling prices.');seenPrices.set(skuId,key);if(!p.existingSkuId&&!initialPrices.has(skuId))initialPrices.set(skuId,{skuId,amountMinor:p.sellingPriceMinor,currency:p.currency,source:'opening_import',sourceDetail:{importId:id,importRowId:row.id}});}
  const initial=[...initialPrices.values()];for(let start=0;start<initial.length;start+=500)await postgresPrices.setPricesInTransaction(client,ctx,initial.slice(start,start+500),{initialize:true});
  const bindingMap=new Map();for(const row of sourceRows){const p=row.parsed;if(p.existingSkuId)continue;const product=key(productKey(p)),variant=key(variantKey(p));bindingMap.set(product+':'+variant,{product_key:product,variant_key:variant,item_id:p.createdItemId,sku_id:p.createdSkuId});}const bindings=[...bindingMap.values()];for(let start=0;start<bindings.length;start+=500){const batch=bindings.slice(start,start+500),savedBindings=await client.query('INSERT INTO import_catalogue_bindings(workspace_id,import_id,product_key,variant_key,item_id,sku_id) SELECT $1,$2,x.product_key,x.variant_key,x.item_id,x.sku_id FROM jsonb_to_recordset($3::jsonb) AS x(product_key text,variant_key text,item_id text,sku_id text)',[ctx.workspaceId,id,JSON.stringify(batch)]);if(savedBindings.rowCount!==batch.length)throw new ValidationError('Prepared source identities did not reconcile.');}
  return save(client,{version:1,cataloguePrepared:true,initialPricesPrepared:true,locations:Object.fromEntries(newLocations),postingDate:await require('../lib/business-time').today(client,ctx.workspaceId),itemsCreated,skusCreated,itemsUpdated:new Set(sourceRows.map(row=>row.parsed.existingItemId).filter(Boolean)).size,savedRows:0,units:0});
 });
 await emit('preparing',sourceRows.length);
 const settingCounts=plan.transformations.importMode==='set',isCount=row=>settingCounts&&row.parsed.existingSkuId&&row.parsed.quantity!==null,expectedDelta=row=>isCount(row)?row.parsed.countQuantityDelta:(row.parsed.quantity||0),expectedCost=row=>isCount(row)?row.parsed.countCostDeltaMinor:(row.parsed.quantity||0)*(row.parsed.unitCostMinor||0),expectsCostRecord=row=>isCount(row)?expectedDelta(row)>0&&row.parsed.unitCostMinor!==null||expectedDelta(row)<0&&row.parsed.inventoryBefore.costed>0:row.parsed.quantity>0&&row.parsed.unitCostMinor!==null;
 const priceCache=new Map();for(const row of sourceRows)if((row.imported||checkpoint.initialPricesPrepared&&!row.parsed.existingSkuId)&&row.parsed.sellingPriceMinor!==null)priceCache.set(row.parsed.existingSkuId||row.parsed.createdSkuId,row.parsed.currency+':'+row.parsed.sellingPriceMinor);
 const pendingRows=sourceRows.filter(row=>!row.imported);
 for(let start=0;start<pendingRows.length;start+=500){const chunk=pendingRows.slice(start,start+500),priorSaved=Number(checkpoint.savedRows||0);
  await emit('processing');
  const result=await phase(async(client,saved)=>{
   const sourceRows=chunk,options={...inputOptions,beforeRow:value=>inputOptions.beforeRow?.({...value,rowsImported:priorSaved+value.rowsImported})},publishProgress=()=>{};
   const salePriceBySku=new Map();for(const row of chunk){const skuId=row.parsed.existingSkuId||row.parsed.createdSkuId;if(priceCache.has(skuId))salePriceBySku.set(skuId,priceCache.get(skuId));}
   let savedRows=[],pendingValues=[],units=0,rowsImported=0;
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

      // Batch across product boundaries. Per-product chunks turn a large flat
      // catalogue into thousands of single-row stock/accounting round trips.
      for(let chunkStart=0;chunkStart<sourceRows.length;chunkStart+=500){
        const chunk=sourceRows.slice(chunkStart,chunkStart+500),receiving=chunk.filter(row=>row.parsed.quantity>0&&!isCount(row));
        const newPrices=[],initialPrices=[];
        for(const row of chunk){if(row.parsed.sellingPriceMinor===null)continue;
          const skuId=row.parsed.existingSkuId||row.parsed.createdSkuId,saleKey=`${row.parsed.currency}:${row.parsed.sellingPriceMinor}`;
          if(salePriceBySku.has(skuId)&&salePriceBySku.get(skuId)!==saleKey)throw new ValidationError(`Conflicting selling prices for ${row.parsed.name} in this import.`);
          if(!salePriceBySku.has(skuId)){(row.parsed.existingSkuId?newPrices:initialPrices).push({skuId,amountMinor:row.parsed.sellingPriceMinor,currency:row.parsed.currency,source:'opening_import',...(Object.hasOwn(row.parsed,'currentPriceId')?{expectedCurrentId:row.parsed.currentPriceId}:{}),sourceDetail:{importId:id,importRowId:row.id}});salePriceBySku.set(skuId,saleKey);}
        }
        await postgresPrices.setPricesInTransaction(client,ctx,newPrices);
        await postgresPrices.setPricesInTransaction(client,ctx,initialPrices,{initialize:true});
        const receivedRows=await inventory.receiveManyInTransaction(client,ctx,receiving.map(row=>({
          skuId:row.parsed.existingSkuId||row.parsed.createdSkuId,locationId:row.parsed.locationId,quantity:row.parsed.quantity,
          serials:row.parsed.serial?[row.parsed.serial]:undefined,lotCode:row.parsed.lotCode,expiresAt:row.parsed.expiresAt,lotReceivedAt:row.parsed.receivedAt,
          notes:row.parsed.notes,reference:`Import ${plan.sourceName} row ${row.rowNumber}`,idempotencyKey:`import:${id}:row:${row.id}`})));
        const receiptByRow=new Map(receiving.map((row,index)=>[row.id,receivedRows[index]]));
        const countedByRow=new Map();
        for(const row of chunk.filter(isCount)){
          const value=await require('../accounting/postgres-physical-count').applyInTransaction(client,ctx,{
            skuId:row.parsed.existingSkuId,locationId:row.parsed.locationId,countedQuantity:row.parsed.quantity,
            expectedBefore:row.parsed.inventoryBefore,expectedCostDeltaMinor:row.parsed.countCostDeltaMinor,
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
          if(isCount(row)){
            const counted=countedByRow.get(row.id);if(counted.movementId)movementIds.push(counted.movementId);units+=expectedDelta(row);
          }else if(row.parsed.quantity>0){
            const received=receiptByRow.get(row.id);
            movementIds.push(received.movementId);units+=row.parsed.quantity;
            if(row.parsed.unitCostMinor!==null){
              const totalCostMinor=row.parsed.quantity*row.parsed.unitCostMinor;
              pendingValues.push({row,skuId,movementId:received.movementId,totalCostMinor,postingDate:checkpoint.postingDate});
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
              supplierId=existing[0]?.id||(await commerce.createSupplierInTransaction(client,ctx,{name:p.supplierName,currency:p.currency})).id;suppliersByName.set(name,supplierId);}
            supplierLinks.push({supplierId,skuId,...(p.reorder?.leadTimeDays===undefined?{}:{leadTimeDays:p.reorder.leadTimeDays})});
          }
        }
        await commerce.linkSupplierItemsInTransaction(client,ctx,supplierLinks);
        await require('../domain/postgres-catalog-facts').saveManyInTransaction(client,ctx,facts);
        await require('../operations/postgres-reorder-policies').setManyInTransaction(client,ctx,policies);
      }

   const totals=await verification.totals(client,ctx.workspaceId,chunk.map(row=>row.id)),value=chunk.reduce((n,row)=>n+expectedCost(row),0),expectedUnits=chunk.reduce((n,row)=>n+expectedDelta(row),0),valued=chunk.filter(expectsCostRecord).length;
   const checks=[{name:'Rows saved',expected:chunk.length,observed:rowsImported,ok:rowsImported===chunk.length},{name:'Stock movement units',expected:expectedUnits,observed:units,ok:units===expectedUnits},{name:'Cost records',expected:valued,observed:totals.value.movements,ok:valued===totals.value.movements},{name:'Inventory cost',expected:value,observed:Number(totals.value.value),ok:value===Number(totals.value.value)},{name:'Inventory asset',expected:value,observed:Number(totals.posted.value),ok:value===Number(totals.posted.value)}];
   if(!checks.every(check=>check.ok))throw new ValidationError('The imported stock and accounting evidence did not reconcile. The current batch was not saved.',{checks});
   const next=await save(client,{...saved,savedRows:priorSaved+chunk.length,units:Number(saved.units||0)+units,lastBatch:{executionId,firstRow:chunk[0].rowNumber,lastRow:chunk.at(-1).rowNumber,checks}});
   await client.query('UPDATE import_executions SET items_created=$3,skus_created=$4,rows_imported=$5,units_established=$6,stage=$7 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,executionId,next.itemsCreated,next.skusCreated,next.savedRows,next.units,'processing']);
   return {checkpoint:next,prices:[...salePriceBySku]};
  });
  checkpoint=result.checkpoint;for(const pair of result.prices)priceCache.set(...pair);for(const row of chunk)row.imported=true;await emit('processing');
 }
 await emit('verifying');
 const totals=await database.transaction(client=>verification.totals(client,ctx.workspaceId,sourceRows.map(row=>row.id)),{isolation:'REPEATABLE READ',readOnly:true});
 const expectedUnits=sourceRows.reduce((n,row)=>n+expectedDelta(row),0),expectedValue=sourceRows.reduce((n,row)=>n+expectedCost(row),0),valued=sourceRows.filter(expectsCostRecord).length;
 const checks=[{name:'Rows imported',expected:sourceRows.length,observed:checkpoint.savedRows,ok:checkpoint.savedRows===sourceRows.length},{name:'Net stock change',expected:expectedUnits,observed:checkpoint.units,ok:checkpoint.units===expectedUnits},{name:'Valued receipt records',expected:valued,observed:totals.value.movements,ok:valued===totals.value.movements},{name:'Inventory cost change in minor units',expected:expectedValue,observed:Number(totals.value.value),ok:expectedValue===Number(totals.value.value)},{name:'Inventory asset posted in minor units',expected:expectedValue,observed:Number(totals.posted.value),ok:expectedValue===Number(totals.posted.value)}];
 if(!checks.every(check=>check.ok))throw new ValidationError('Saved import records need reconciliation. Verified batches remain recorded.',{checks});
 return phase(async client=>{const count=Number((await client.query("SELECT count(*) n FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'",[ctx.workspaceId,id])).rows[0].n);if(count!==sourceRows.length)throw new ValidationError('Some approved rows remain unsaved. Continue the import.');
  const at=nowIso(),verificationId=newId('impverify'),observed={itemsCreated:checkpoint.itemsCreated,itemsUpdated:checkpoint.itemsUpdated,skusCreated:checkpoint.skusCreated,rowsImported:count,units:checkpoint.units};
  await client.query("INSERT INTO import_verifications(id,workspace_id,import_id,execution_id,verified,checks,observed,problems,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'[]',$7)",[verificationId,ctx.workspaceId,id,executionId,JSON.stringify(checks),JSON.stringify(observed),at]);
  await client.query("UPDATE import_executions SET status='SUCCEEDED',stage='verified',items_created=$3,skus_created=$4,rows_imported=$5,units_established=$6,result=$7,finished_at=$8 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,executionId,checkpoint.itemsCreated,checkpoint.skusCreated,count,checkpoint.units,JSON.stringify({verificationId,verified:true,checks,durable:true}),at]);
  await save(client,{...checkpoint,complete:true});await client.query("UPDATE import_plans SET status='SUCCEEDED',completed_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,at]);await inputOptions.beforeCommit?.();return {...observed,executionId,verificationId,verified:true,checks,durable:true};
 });
}
module.exports={run};
