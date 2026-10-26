'use strict';

async function authorize(db,ctx,source){
 if(source?.capability==='communications.ai_drafts'){
  await require('./postgres-mail-preparation').authorize(db,ctx,source);return {readOnly:true};
 }
 await require('./postgres-document-review').authorize(db,ctx,source);return {};
}
function processing(goal){
 const source=goal.checkpoint.sourceAutomation;
 if(source?.capability!=='communications.ai_drafts')return null;
 if(!source.processingInput)throw new Error('MISSING_BOUNDED_PREPARATION_INPUT');
 return require('./postgres-reply-drafting').requestFor(source.processingInput.message,source.processingInput.facts);
}
async function completeProcessing(db,ctx,goal,data){
 if(goal.checkpoint.sourceAutomation?.capability!=='communications.ai_drafts')throw new Error('UNKNOWN_STRUCTURED_PREPARATION');
 return require('./postgres-mail-preparation').completeProcessing(db,ctx,goal,data);
}
module.exports={authorize,processing,completeProcessing};
