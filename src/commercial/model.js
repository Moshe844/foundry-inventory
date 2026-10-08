'use strict';
const usage=require('./entitlements');const operations=require('./operations');const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const POLICIES=Object.freeze({ask:{capability:'ask.lookup',maxPromptCharacters:180000,maxOutputTokens:3000},
 instruction:{capability:'ask.prepare_actions',maxPromptCharacters:180000,maxOutputTokens:8000},
 import_mapping:{capability:'imports.spreadsheet',maxPromptCharacters:180000,maxOutputTokens:3000}});
function wrap(database,ctx,provider,operation,key,options={}){const policy=POLICIES[operation];if(!policy)throw new ValidationError('Unregistered commercial model operation.');
 return {...provider,async complete(request){const scope=await usage.ownerScopeForWorkspace(database,ctx.workspaceId);
  await usage.assertCapability(database,scope,policy.capability);
  if(String(request.system||'').length+String(request.prompt||'').length>policy.maxPromptCharacters)throw new ValidationError('This request is too large for the approved operation budget.');
  const configured=(await database.query('SELECT * FROM commercial_operation_policies WHERE operation=$1',[operation])).rows[0];
  if(!configured||configured.category!=='ai_work_credits')throw new ValidationError('The model operation has no configured usage policy.');
  const idempotencyKey=`${ctx.workspaceId}:${key||newId('modeloperation')}`;
  const internal=options.chargeCustomer===false;
  if(internal&&(!options.fundingKey||!['ask','instruction'].includes(operation)))
    throw new ValidationError('An internal model call needs its original funded request.');
  if(!internal){const reserved=await usage.reserveUsage(database,scope,{meter:'ai_work_credits',units:Number(configured.units),idempotencyKey,
    detail:{operation,model:provider.model,provisional:true}});
    if(!reserved.created)throw new ValidationError('This model operation is already recorded or in progress.');}
  let response;let modelAttemptDay=null;let providerStarted=false;let costHold=null;
  try{costHold=await require('./model-cost-budget').reserve(database,scope,provider,request,policy,operation,
    idempotencyKey,internal?`${ctx.workspaceId}:${options.fundingKey}`:idempotencyKey);
    modelAttemptDay=await require('./model-budget').begin(database,scope.accountId);
    const {onValidated,...providerRequest}=request;
    providerStarted=true;response=await provider.complete({...providerRequest,maxOutputTokens:costHold.outputTokenLimit,commercial:true});
    await operations.modelUsage(database,scope,response.usage||{provider:provider.name,model:provider.model},idempotencyKey,{operation});
    const validated=require('../foundry/validator').validate(require('../foundry/schema-tools').toWireSchema(request.schema),response.data);
    if(!validated.ok)throw new (require('../ai/provider').ProviderOutputError)('The model response did not match the operation contract. No credits were consumed.',validated.errors);
    if(operation==='instruction'&&request.schemaName==='postgres_operating_instruction'
      &&(!response.data?.understood||!response.data?.changes?.length))
      throw new ValidationError(response.data?.unsupportedReason||response.data?.clarifyingQuestion||'No supported operating instruction was produced.');
    if(typeof onValidated==='function')await onValidated(response.data);
    await require('./model-cost-budget').settle(database,scope,idempotencyKey);
    if(!internal)await usage.commitUsage(database,scope,{meter:'ai_work_credits',idempotencyKey});return response;
  }catch(error){if(modelAttemptDay)await require('./model-budget').failed(database,scope.accountId,modelAttemptDay);
    if(error.usage)await operations.modelUsage(database,scope,error.usage,idempotencyKey,{operation,failed:true});
    else if(providerStarted&&!response)await require('./control-service').recordCost(database,scope,{provider:provider.name||'unknown',model:provider.model||'',
      operation:'unknown_model_outcome',unit:'request',quantity:1,idempotencyKey,detail:{operation,errorCode:error.code}});
    if(costHold){if(providerStarted)await require('./model-cost-budget').settle(database,scope,idempotencyKey,{failed:true});
      else await require('./model-cost-budget').release(database,scope,idempotencyKey);}
    if(!internal)await usage.reverseUsage(database,scope,{meter:'ai_work_credits',idempotencyKey,reason:error.message});throw error;}
 }};}
module.exports={POLICIES,wrap};
