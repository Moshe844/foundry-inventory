'use strict';
const {ValidationError}=require('../domain/errors');
const versions=Object.freeze({stock_threshold:1,purchase_followup:1,shipment_notice:1,quote_followup:1,quote_share:1,customer_statement:1,invoice_reminder:1,stock_ready_notice:1,invoice_dispute:1,supplier_forecast:1,supplier_rfq:1});
const kinds=Object.freeze(Object.entries(versions).map(([name,version])=>'agent.mail.'+name+'.v'+version));
function jobKind(effect){
 if(effect.kind!=='mail.outbound.send'||!effect.payload?.standingAuthority)return 'provider.effect';
 const name=effect.payload.standingAuthority.kind;
 if(!Object.hasOwn(versions,name))throw Object.assign(new ValidationError('This message requires a supported StockChief mail worker. Review its saved progress before retrying.'),{code:'unsupported_agent_mail_authority',retryable:false});
 return 'agent.mail.'+name+'.v'+versions[name];
}
function assertJob(effect,kind){if(jobKind(effect)!==kind)throw Object.assign(new ValidationError('This worker does not support the saved message authority. A compatible worker must process it.'),{code:'incompatible_agent_mail_worker',retryable:false});}
module.exports={kinds,jobKind,assertJob};
