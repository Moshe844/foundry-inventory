'use strict';
const entitlements=require('./entitlements'),{DomainError}=require('../domain/errors');
async function admitMinute(db,scope){
 const state=await entitlements.meterState(db,scope,'api_requests_per_minute');if(state.hardLimit===null)return;
 const result=await db.query(`INSERT INTO commercial_api_minute_usage(account_id,minute_start,requests) SELECT $1,date_trunc('minute',now()),1 WHERE $2::bigint>0
 ON CONFLICT(account_id,minute_start) DO UPDATE SET requests=commercial_api_minute_usage.requests+1 WHERE commercial_api_minute_usage.requests<$2 RETURNING requests`,[scope.accountId,state.hardLimit]);
 if(!result.rows.length)throw new DomainError('Your account has reached its API requests per minute limit. Try again next minute, or upgrade for more capacity.',{code:'rate_limited',status:429});
}
async function begin(db,scope,key){const sub=await entitlements.subscriptionFor(db,scope.accountId);if(!sub?.plan_configuration?.offerId)return null;
 await admitMinute(db,scope);const input={meter:'api_requests',units:1,idempotencyKey:key};await entitlements.reserveUsage(db,scope,input);return {scope,input};}
async function settle(db,held,ok){if(!held)return;return ok?entitlements.commitUsage(db,held.scope,held.input):entitlements.reverseUsage(db,held.scope,{...held.input,reason:'The API request was not accepted.'});}
module.exports={admitMinute,begin,settle};
