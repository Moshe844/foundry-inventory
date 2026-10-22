'use strict';

// Approval and its explanation use the same source-independent plan rules.
// Row-level evidence, authority and capacity are still checked under the plan
// lock by the canonical service. A review link never authorizes execution.
function planRequirements(plan){
 const m=plan.fieldMappings||{},t=plan.transformations||{},out=[];
 const add=(code,title,detail,href,action,error)=>out.push({code,title,detail,href,action,error});
 if(plan.isExpired)add('expired','Read this file again','This saved preview is more than 24 hours old. Prepare a fresh preview before approval.','/imports/start','Read the file again','This preview is more than 24 hours old. Read the source again before importing.');
 if(!t.workbook&&t.sheetCount>1&&t.worksheetScope?.confirmed!==true)add('worksheets','Review the worksheet scope','Confirm which worksheets belong in this import.','#worksheet-scope','Review worksheets','Review every worksheet before approval. Read the complete workbook again, or explicitly confirm the displayed worksheet scope; other worksheets will not be imported.');
 if((plan.sourceKind==='image'||t.visualSource===true)&&t.imageReadingConfirmed!==true)add('image','Check the image reading','Compare the extracted codes, quantities and prices with the original, then save your review.','#image-reading','Review image reading','Review the image’s product codes, quantities and prices against the original, save any SKU corrections and confirm the reading before approving.');
 if(m.name===undefined&&m.code===undefined)add('identity','Identify the products','Choose the column containing product names or codes.','#column-mapping','Review product columns','Map a product name or SKU and recalculate the preview before approving.');
 if(t.existingStockRows>0&&!t.importMode)add('stock-intent','Choose how quantities affect existing stock','Choose whether these counts replace on-hand quantities or record an additional delivery.','#import-stock-intent','Choose how to use quantities','This file matches existing stock. Choose set on-hand quantities or receive additional stock before approval.');
 if(plan.recordsInvalid>0){
  const complete=Boolean(t.workbook||m.serialTracked!==undefined||m.lotTracked!==undefined);
  if(complete||!t.allowPartialImport)add('rows','Resolve the rows needing attention',complete?'This source must be reviewed as a complete inventory. Resolve its required questions and row errors before approval.':'Correct invalid rows, or explicitly review a partial import.','#import-rows','Review rows',t.workbook?'This workbook still has unresolved source rows. Resolve them before approving the complete inventory; StockChief will not silently import only part of it.':complete?'Resolve the tracking requirements and invalid rows before approving this inventory. StockChief will not silently skip part of the source.':'Correct the invalid rows, or explicitly review and choose a partial import first.');
 }
 if(!plan.recordsValid&&!out.some(r=>r.code==='rows'))add('empty','No rows are ready','Review the column meanings and row explanations before approval.','#import-rows','Review rows','There are no valid rows to import.');
 return out;
}

function review(plan,evidence={}){
 const t=plan.transformations||{},requirements=planRequirements(plan),extra=[];
 const add=(code,title,detail,href,action)=>extra.push({code,title,detail,href,action});
 if(evidence.previewRevision?.active)add('updating','Wait for the saved preview update','StockChief is recalculating your choices. You can leave and return; review the finished result before approval.','#preview-update','See preview progress');
 if(evidence.duplicatePlans?.length)add('duplicate','This file was already imported','The same completed source cannot be applied twice.','/imports/'+evidence.duplicatePlans[0].id,'See the completed import');
 if(evidence.missingAccountingSetup)add('accounting','Set up Money for the inventory value','Set the accounting currency and opening date once for this inventory.','#import-money-setup','Set up Money');
 if(evidence.missingLocationRows||(plan.conflicts||[]).length)add('location','Choose where the stock is kept','Complete or match the location choices before approval.','#import-location-review','Review stock locations');
 if(evidence.needsNumberAnswer)add('quantity','Identify the stock quantities','Choose which numbers describe on-hand stock, or explicitly confirm a product catalogue with no stock.',requirements.some(r=>r.code==='identity')?'#column-mapping':'#import-number-question','Review quantity columns');
 if(evidence.trackingQuestion?.state==='needs_input'){
  const groups=evidence.trackingQuestion.groups.filter(g=>g.missingSkus>0),counts=groups.map(g=>`${Number(g.missingSkus).toLocaleString('en-US')} ${g.mode==='serial'?'serial-tracked':'batch-tracked'} SKUs`).join(' and ');
  add('tracking','Confirm how these products are tracked',`The file marks ${counts} but does not supply the required identifiers. Confirm whether those requirements apply, or upload a source containing the missing identifiers.`,'#import-tracking-question','Review tracking choices');
 }
 // A required question explains the affected invalid rows. Do not present the
 // same issue twice as a separate, apparently unanswerable partial-import step.
 const explainsRows=extra.some(r=>['accounting','location','tracking','quantity'].includes(r.code))||requirements.some(r=>['image','identity'].includes(r.code));
 const blockers=[...extra,...requirements.filter(r=>r.code!=='rows'||!explainsRows)];
 const editable=plan.status==='READY'&&plan.approvalStatus==='AWAITING_APPROVAL';
 return {blockers,canApprove:editable&&blockers.length===0,needsAnswer:blockers.length>0,
  needsTrackingAnswer:evidence.trackingQuestion?.state==='needs_input',needsImageAnswer:requirements.some(r=>r.code==='image'),
  needsIdentity:requirements.some(r=>r.code==='identity'),needsStockIntent:requirements.some(r=>r.code==='stock-intent'),needsWorksheetScope:requirements.some(r=>r.code==='worksheets'),
  needsNumberAnswer:Boolean(evidence.needsNumberAnswer),needsLocation:Boolean(evidence.missingLocationRows),needsAccounting:Boolean(evidence.missingAccountingSetup),
  needsPartialAnswer:plan.recordsInvalid>0&&!t.allowPartialImport};
}
module.exports={planRequirements,review};
