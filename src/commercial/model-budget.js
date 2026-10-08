'use strict';
const {RateLimitError}=require('../domain/errors');
function ceiling(name,fallback){const value=process.env[name];if(value===undefined)return fallback;
 const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw Error(`${name} must be a positive whole number`);
 return parsed;}
async function begin(database,accountId){
 const maxAttempts=ceiling('STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY',250);
 const maxFailures=ceiling('STOCKCHIEF_AI_MAX_FAILED_MODEL_ATTEMPTS_PER_DAY',12);
 const row=(await database.query(`INSERT INTO commercial_model_daily_attempts(account_id,day,attempts)
  VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
  ON CONFLICT(account_id,day) DO UPDATE SET attempts=commercial_model_daily_attempts.attempts+1
  WHERE commercial_model_daily_attempts.attempts<$2 AND commercial_model_daily_attempts.failures<$3
  RETURNING day,attempts,failures`,[accountId,maxAttempts,maxFailures])).rows[0];
 if(!row){const error=new RateLimitError('This inventory has reached its daily model-attempt safety limit. Try again after the UTC daily reset; no new model call was made.');
  error.limitKind='daily_model_attempts';throw error;}
 return row.day;
}
async function failed(database,accountId,day){await database.query(`UPDATE commercial_model_daily_attempts
 SET failures=failures+1 WHERE account_id=$1 AND day=$2`,[accountId,day]);}
module.exports={begin,failed,ceiling};
