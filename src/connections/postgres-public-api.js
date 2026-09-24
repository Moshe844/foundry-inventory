'use strict';

const crypto=require('node:crypto');
const {newId,nowIso,requireText}=require('../lib/util');
const {AuthenticationError,ValidationError,InvariantError}=require('../domain/errors');

const PREFIX='fnd_api_';
const ALLOWED_SCOPES=Object.freeze(['inventory:read','inventory:write']);
const hash=(value)=>crypto.createHash('sha256').update(String(value)).digest('hex');

function parse(value,fallback=[]){
  if(value&&typeof value==='object')return value;
  try{return JSON.parse(value)??fallback;}catch{return fallback;}
}

function scopes(input){
  const requested=Array.isArray(input)?input:[input].filter(Boolean);
  const selected=[...new Set(requested.map(String))];
  if(!selected.length||selected.some((scope)=>!ALLOWED_SCOPES.includes(scope))){
    throw new ValidationError('Choose at least one supported API scope.');
  }
  return selected;
}

async function create(database,ctx,input={}){
  const name=requireText(input.name,'API client name',{max:100});
  const selected=scopes(input.scopes);const visible=crypto.randomBytes(6).toString('hex');
  const token=`${PREFIX}${visible}.${crypto.randomBytes(32).toString('base64url')}`;
  const row={id:newId('apiclient'),prefix:`${PREFIX}${visible}`,name,scopes:selected};
  await database.query(`INSERT INTO public_api_clients
    (id,workspace_id,name,scopes,token_prefix,token_hash,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,ctx.workspaceId,name,JSON.stringify(selected),row.prefix,
    hash(token),ctx.actorId,nowIso()]);
  return {...row,token};
}

async function list(database,workspaceId){
  const rows=(await database.query(`SELECT id,name,scopes,token_prefix,created_at,last_used_at,revoked_at
    FROM public_api_clients WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC`,[workspaceId])).rows;
  return rows.map((row)=>({...row,scopes:parse(row.scopes)}));
}

async function revoke(database,workspaceId,id){
  const result=await database.query(`UPDATE public_api_clients SET revoked_at=$3
    WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`,[workspaceId,id,nowIso()]);
  if(!result.rows.length)throw new ValidationError('That API client is already revoked or does not exist.');
}

async function authenticate(database,authorization,requiredScope){
  const match=/^Bearer\s+(.+)$/i.exec(String(authorization||''));
  if(!match||!match[1].startsWith(PREFIX))throw new AuthenticationError('Use a valid StockChief API bearer token.');
  return database.transaction(async(client)=>{
    const result=await client.query(`SELECT api.*,account_user.account_id FROM public_api_clients api
      JOIN users account_user ON account_user.id=api.created_by_user_id
        AND account_user.workspace_id=api.workspace_id
      WHERE api.token_hash=$1 AND api.revoked_at IS NULL FOR UPDATE OF api`,[hash(match[1])]);
    const row=result.rows[0];
    if(!row)throw new AuthenticationError('This API token is invalid or revoked.');
    const granted=parse(row.scopes);
    if(requiredScope&&!granted.includes(requiredScope)){
      const error=new AuthenticationError(`This API token does not have ${requiredScope} authority.`);
      error.status=403;throw error;
    }
    await client.query('UPDATE public_api_clients SET last_used_at=$2 WHERE id=$1',[row.id,nowIso()]);
    return {clientId:row.id,workspaceId:row.workspace_id,actorId:row.created_by_user_id,
      accountId:row.account_id,scopes:granted};
  },{isolation:'READ COMMITTED'});
}

async function executeCommand(database,auth,input,handler){
  const key=requireText(input.idempotencyKey,'Idempotency-Key header',{max:200});
  const commandType=requireText(input.commandType,'Command type',{max:100});
  const requestHash=hash(JSON.stringify(input.body||{}));
  return database.transaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${auth.clientId}:${key}`]);
    const prior=(await client.query(`SELECT * FROM public_api_commands
      WHERE client_id=$1 AND idempotency_key=$2`,[auth.clientId,key])).rows[0];
    if(prior){
      if(prior.request_hash!==requestHash||prior.command_type!==commandType){
        throw new InvariantError('That Idempotency-Key was already used for a different command.',
          'idempotency_key_conflict');
      }
      return {result:parse(prior.result,{}),replayed:true};
    }
    const result=await handler(client,`public-api:${auth.clientId}:${key}`);
    await client.query(`INSERT INTO public_api_commands
      (id,workspace_id,client_id,idempotency_key,command_type,request_hash,result,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newId('apicmd'),auth.workspaceId,auth.clientId,key,commandType,
      requestHash,JSON.stringify(result),nowIso()]);
    return {result,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={PREFIX,ALLOWED_SCOPES,hash,parse,create,list,revoke,authenticate,executeCommand};
