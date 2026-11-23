'use strict';

// A code emailed at each password sign-in, unless the browser was remembered
// for 30 or 60 days with an earlier code.
const crypto=require('node:crypto');
const config=require('../config');
const credentials=require('../connections/credentials');
const jobs=require('../operations/postgres-job-queue');
const {newId}=require('../lib/util');
const {ValidationError,RateLimitError}=require('./errors');

const CODE_MINUTES=10,MAX_TRIES=5,RESEND_SECONDS=30,CODES_PER_QUARTER_HOUR=5;
const REMEMBER_DAYS=[30,60];
const DEVICE_COOKIE='stockchief.device',DEVICE_TOKENS_KEPT=5;

const keyed=(value)=>crypto.createHmac('sha256',String(config.sessionSecret||'stockchief-sign-in-code')).update(String(value)).digest('hex');
const tokenHash=(token)=>crypto.createHash('sha256').update(String(token)).digest('hex');
const scopedDatabase=(client)=>({query:(statement,values=[])=>client.query(statement,values),transaction:(operation)=>operation(client)});
const rememberDays=(value)=>REMEMBER_DAYS.includes(Number(value))?Number(value):REMEMBER_DAYS[0];
const digitsOf=(value)=>String(value||'').replace(/\D/g,'');

// Signed-in emails come from the queue worker, which polls every half second.
function message(account,code,origin){
  const reset=`${String(origin||'').replace(/\/$/,'')}/forgot-password`;
  return {to:account.email,subject:`${code} is your StockChief sign-in code`,
    text:`Your StockChief sign-in code is ${code}\n\nEnter it on the sign-in page within ${CODE_MINUTES} minutes.\n\nIf you did not just try to sign in, someone may know your password. Change it now: ${reset}`,
    html:`<p>Your StockChief sign-in code is</p><p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:12px 0">${code}</p><p>Enter it on the sign-in page within ${CODE_MINUTES} minutes.</p><p style="color:#667085">If you did not just try to sign in, someone may know your password. <a href="${reset}">Change your password</a>.</p>`};
}

async function send(database,account,options={}){
  const origin=options.origin||config.connections.publicOrigin;
  return database.transaction(async(client)=>{
    // One sender at a time per account, so the limits below hold under double clicks.
    await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[account.id]);
    const recent=(await client.query(`SELECT count(*)::int AS sent,max(created_at) AS last,
      extract(epoch FROM now()-max(created_at))::float AS age FROM sign_in_codes
      WHERE account_id=$1 AND created_at>now()-interval '15 minutes'`,[account.id])).rows[0];
    if(recent.sent>=CODES_PER_QUARTER_HOUR)throw new RateLimitError('Too many codes were sent. Wait 15 minutes, then try again.');
    if(recent.last&&recent.age<RESEND_SECONDS&&options.resend)
      throw new RateLimitError(`A code was just sent. You can ask for another in ${Math.max(1,Math.ceil(RESEND_SECONDS-recent.age))} seconds.`);
    const id=newId('signin'),code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
    await client.query('UPDATE sign_in_codes SET used_at=now() WHERE account_id=$1 AND used_at IS NULL',[account.id]);
    await client.query(`INSERT INTO sign_in_codes(id,account_id,code_hash,requested_ip,expires_at)
      VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5))`,[id,account.id,keyed(id+':'+code),options.ip||null,CODE_MINUTES]);
    await jobs.enqueue(scopedDatabase(client),{kind:'system.email-send',idempotencyKey:`sign-in-code:${id}`,
      payload:{messageType:'sign_in_code',accountId:account.id,signInCodeId:id,sealed:credentials.encrypt(message(account,code,origin))},
      priority:1,maxAttempts:5});
    return {id,minutes:CODE_MINUTES};
  });
}

async function verify(database,{id,accountId,code}){
  const entered=digitsOf(code);
  if(entered.length!==6)throw new ValidationError('Enter the 6-digit code from the email.');
  const outcome=await database.transaction(async(client)=>{
    const row=(await client.query(`SELECT *,expires_at<=now() AS expired FROM sign_in_codes
      WHERE id=$1 AND account_id=$2 FOR UPDATE`,[id,accountId])).rows[0];
    if(!row||row.used_at||row.expired)return {error:'That code has expired. Send a new code.'};
    if(row.attempts>=MAX_TRIES)return {error:'Too many wrong tries. Send a new code.'};
    const expected=Buffer.from(row.code_hash,'hex'),given=Buffer.from(keyed(id+':'+entered),'hex');
    if(!crypto.timingSafeEqual(expected,given)){
      const tries=row.attempts+1;
      await client.query('UPDATE sign_in_codes SET attempts=$2 WHERE id=$1',[id,tries]);
      return {error:tries>=MAX_TRIES?'That code is not right, and that was the last try. Send a new code.':
        `That code is not right. Check the newest email and try again (${MAX_TRIES-tries} ${MAX_TRIES-tries===1?'try':'tries'} left).`};
    }
    await client.query('UPDATE sign_in_codes SET used_at=now() WHERE id=$1',[id]);
    return {ok:true};
  });
  // The wrong-try count must be kept, so the refusal is raised after the transaction commits.
  if(outcome.error)throw new ValidationError(outcome.error);
  return true;
}

function deviceTokens(req){
  const header=String(req.headers?.cookie||'');
  const raw=header.split(';').map(part=>part.trim()).find(part=>part.startsWith(DEVICE_COOKIE+'='));
  if(!raw)return [];
  return decodeURIComponent(raw.slice(DEVICE_COOKIE.length+1)).split('.').filter(token=>/^[A-Za-z0-9_-]{30,60}$/.test(token)).slice(0,DEVICE_TOKENS_KEPT);
}

async function trusted(database,accountId,tokens){
  if(!tokens.length)return false;
  const row=(await database.query(`UPDATE trusted_sign_in_devices SET last_used_at=now()
    WHERE account_id=$1 AND token_hash=ANY($2::text[]) AND revoked_at IS NULL AND expires_at>now() RETURNING id`,
  [accountId,tokens.map(tokenHash)])).rows[0];
  return Boolean(row);
}

async function remember(database,accountId,{days,browser=null}){
  const token=crypto.randomBytes(32).toString('base64url');
  await database.query(`INSERT INTO trusted_sign_in_devices(id,account_id,token_hash,browser,expires_at)
    VALUES($1,$2,$3,$4,now()+make_interval(days=>$5))`,[newId('device'),accountId,tokenHash(token),browser?String(browser).slice(0,300):null,rememberDays(days)]);
  return token;
}

async function forgetDevices(database,accountId){
  await database.query('UPDATE trusted_sign_in_devices SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL',[accountId]);
}

// The browser keeps one token per remembered account, newest first.
function deviceCookie(tokens,newest){
  return [newest,...tokens.filter(token=>token!==newest)].slice(0,DEVICE_TOKENS_KEPT).join('.');
}

module.exports={CODE_MINUTES,MAX_TRIES,REMEMBER_DAYS,DEVICE_COOKIE,rememberDays,send,verify,deviceTokens,trusted,remember,forgetDevices,deviceCookie};
