
'use strict';

const {ValidationError}=require('../domain/errors');
const EFFECT='payment.refund.create';
const JOB='agent.payment.refund.v1';

function jobKind(effect){
  return effect.kind===EFFECT&&effect.payload?.agentRefundPartId?JOB:null;
}

function assertJob(effect,kind){
  if((jobKind(effect)===JOB)!==(kind===JOB))throw Object.assign(
    new ValidationError('This refund needs a worker that supports its approved original-payment breakdown.'),
    {code:'incompatible_agent_refund_worker',retryable:false});
}

module.exports={EFFECT,JOB,jobKind,assertJob};
