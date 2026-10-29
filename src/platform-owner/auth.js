'use strict';
const crypto=require('node:crypto');
const accountAuth=require('../domain/postgres-auth-service');
const credentials=require('../connections/credentials');
const {newId}=require('../lib/util');
const {AuthorizationError,ValidationError}=require('../domain/errors');
const audit=require('../commercial/control-service').audit;
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function unbase32(value){let bits=0,n=0,bytes=[];for(const char of String(value).toUpperCase()){const index=alphabet.indexOf(char);if(index<0)throw new TypeError('Invalid authenticator key.');n=(n<<5)|index;bits+=5;if(bits>=8){bytes.push((n>>>(bits-8))&255);bits-=8;}}return Buffer.from(bytes);}
function codeAt(secret,counter){const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter));const hash=crypto.createHmac('sha1',unbase32(secret)).update(bytes).digest(),offset=hash.at(-1)&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
function matchedCounter(secret,code,now=Date.now()){if(!/^\d{6}$/.test(String(code)))return null;const counter=Math.floor(now/30000);for(const delta of [0,-1,1]){const n=counter+delta;if(n>=0&&crypto.timingSafeEqual(Buffer.from(codeAt(secret,n)),Buffer.from(String(code))))return n;}return null;}
function version(account){return crypto.createHash('sha256').update(account.password_hash).digest('hex');}
function unseal(value){return credentials.decrypt({...value,auth_tag:value.authTag});}
async function operator(db,id){const account=(await db.query(`SELECT a.id,a.email,a.name,a.password_hash,a.time_zone,o.role,o.active,
 EXISTS(SELECT 1 FROM commercial_admin_accounts c WHERE c.account_id=a.id) legacy_admin
 FROM accounts a LEFT JOIN platform_console_operators o ON o.account_id=a.id WHERE a.id=$1`,[id])).rows[0];
 if(!account)return null;
 // An explicitly disabled operator cannot regain access through the legacy allow-list.
 if(account.active===false)return null;
 const configured=require('../config').commercial.adminEmails.includes(account.email.toLowerCase());
 if(!account.role&&!account.legacy_admin&&!configured)return null;
 return {...account,role:account.role||'OWNER'};
}
async function start(db,input){const account=await accountAuth.authenticate(db,input.email,input.password,{ip:input.ip});
 const actor=account&&await operator(db,account.id);
 if(!actor){await audit(db,{subjectType:'platform_console',subjectId:'sign-in',action:'denied',reason:'Invalid sign-in or no platform role.'});throw new AuthorizationError('Unable to sign in to the private owner console.');}
 const enrolled=(await db.query('SELECT 1 FROM platform_console_mfa WHERE account_id=$1',[actor.id])).rows.length>0;
 const secret=enrolled?null:base32(crypto.randomBytes(20)),id=newId('ownerchallenge');
 await db.query(`INSERT INTO platform_console_challenges(id,account_id,sealed_secret,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')`,[id,actor.id,secret?credentials.encrypt(secret):null]);
 await audit(db,{actorAccountId:actor.id,subjectType:'platform_console',subjectId:actor.id,action:'password_verified',reason:'MFA is still required; no owner session granted.'});
 return {challenge:id,passwordVersion:version(actor),enrollment:!enrolled};
}
async function challenge(db,id){return (await db.query(`SELECT c.*,a.email FROM platform_console_challenges c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND c.attempts<5`,[id])).rows[0]||null;}
async function verify(db,id,code,passwordVersion){return db.transaction(async c=>{
 const pending=(await c.query(`SELECT * FROM platform_console_challenges WHERE id=$1 FOR UPDATE`,[id])).rows[0];
 if(!pending||pending.consumed_at||new Date(pending.expires_at)<=new Date()||pending.attempts>=5)return {error:'Your sign-in expired. Start again.'};
 await c.query('UPDATE platform_console_challenges SET attempts=attempts+1 WHERE id=$1',[id]);
 const actor=await operator(c,pending.account_id);if(!actor||version(actor)!==passwordVersion)return {error:'Your sign-in changed. Start again.'};
 const stored=(await c.query('SELECT * FROM platform_console_mfa WHERE account_id=$1 FOR UPDATE',[actor.id])).rows[0];
 // An enrollment challenge must never replace an authenticator enrolled in another tab.
 if(Boolean(stored)===Boolean(pending.sealed_secret))return {error:'Your authenticator setup changed. Start again.'};
 const secret=unseal(stored?.sealed_secret||pending.sealed_secret),counter=matchedCounter(secret,code);
 if(counter===null||counter<=Number(stored?.last_counter??-1)){
  await audit(c,{actorAccountId:actor.id,subjectType:'platform_console',subjectId:actor.id,action:'mfa_denied',reason:'Invalid, expired or reused authenticator code.'});
  return {error:'That authenticator code is invalid, expired or already used. Try the next code.'};
 }
 if(stored)await c.query('UPDATE platform_console_mfa SET last_counter=$2 WHERE account_id=$1',[actor.id,counter]);
 else await c.query('INSERT INTO platform_console_mfa(account_id,sealed_secret,last_counter) VALUES($1,$2,$3)',[actor.id,pending.sealed_secret,counter]);
 await c.query('UPDATE platform_console_challenges SET consumed_at=now(),sealed_secret=NULL WHERE id=$1',[id]);
 await audit(c,{actorAccountId:actor.id,subjectType:'platform_console',subjectId:actor.id,action:stored?'mfa_sign_in':'mfa_enrolled',reason:'Separate private console session. Customer inventory session is unchanged.'});
 return {accountId:actor.id,passwordVersion:version(actor),enrolledAt:Date.now()};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function sessionActor(db,session,{touch=true}={}){if(!session?.owner)return null;const signed=session.owner,now=Date.now();
 if(now-signed.authenticatedAt>8*3600000||now-signed.lastSeenAt>30*60000)return null;
 const actor=await operator(db,signed.accountId);if(!actor||version(actor)!==signed.passwordVersion)return null;
 if(!(await db.query('SELECT 1 FROM platform_console_mfa WHERE account_id=$1',[actor.id])).rows.length)return null;
 if(touch)session.owner.lastSeenAt=now;return actor;
}
module.exports={base32,codeAt,matchedCounter,operator,start,challenge,verify,sessionActor,unseal};
