'use strict';
const {ValidationError}=require('../domain/errors');
const kind='agent.channel-buffer.publish.v1';
function jobKind(effect){return effect.kind==='commerce.position.publish'&&effect.payload?.channelBuffer?kind:null;}
function assertJob(effect,job){if(jobKind(effect)!==job)throw Object.assign(new ValidationError('This stock update needs a worker that supports its saved channel-buffer authority.'),{code:'incompatible_channel_buffer_worker',retryable:false});}
module.exports={kind,jobKind,assertJob};
