'use strict';
const formats=require('./source-formats'),{ValidationError}=require('../domain/errors');
const limits=Object.freeze({imageBytes:20*1048576,imagePages:10,imagePixels:12000000,pdfBytes:32*1048576,pdfPages:30});
async function presentation(db,workspaceId){
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,workspaceId);
 const subscription=await ent.subscriptionFor(db,scope.accountId);
 const meters=await Promise.all(['products','active_skus','import_rows','agent_documents','ai_work_credits'].map(m=>ent.meterState(db,scope,m,{subscription})));
 const state=await require('../commercial/agent-plan').accountState(db,workspaceId);
 return {planName:subscription?.plan_name||'Current plan',maxBytes:formats.maxBytes,...limits,imageBytes:Math.min(formats.maxBytes,limits.imageBytes),pdfBytes:Math.min(formats.maxBytes,limits.pdfBytes),meters,
  handwriting:require('../commercial/agent-plan').permits(state.plan,139,'draft')&&require('../commercial/agent-plan').usesAgentTerms(state)};
}
function assertFile(input){
 const bytes=input.buffer||Buffer.from(String(input.text||''),'utf8');
 const filename=String(input.filename||'').toLowerCase();
 const pdf=bytes.subarray(0,5).toString()==='%PDF-'||filename.endsWith('.pdf');
 const image=/\.(png|jpe?g|webp|gif|heic|heif|tiff?)$/.test(filename);
 const max=pdf?Math.min(formats.maxBytes,limits.pdfBytes):image?Math.min(formats.maxBytes,limits.imageBytes):formats.maxBytes;
 if(bytes.length>max)throw new ValidationError('This '+(pdf?'PDF':image?'image':'file')+' exceeds the '+Math.floor(max/1048576)+' MB upload limit. Split it into smaller files.');
 return bytes;
}
module.exports={limits,presentation,assertFile};
