'use strict';
const {AuthorizationError,ValidationError,NotFoundError}=require('../domain/errors');
const fields={legalName:['legal_name',160,'Company name'],addressLine1:['address_line1',160,'Address line 1'],
 addressLine2:['address_line2',160,'Address line 2'],city:['city',100,'City'],region:['region',100,'State or region'],
 postalCode:['postal_code',30,'Postal code'],country:['country',80,'Country']};
async function get(db,workspaceId){
 const row=(await db.query(`SELECT w.name,p.* FROM workspaces w LEFT JOIN workspace_company_profiles p
 ON p.workspace_id=w.id WHERE w.id=$1`,[workspaceId])).rows[0];
 if(!row)throw new NotFoundError('That inventory was not found.');
 return {...Object.fromEntries(Object.entries(fields).map(([key,[column]])=>[key,row[column]||(key==='legalName'?row.name:'')])),revision:row.revision||0};
}
function address(profile){return [profile.addressLine1,profile.addressLine2,
 [profile.city,profile.region,profile.postalCode].filter(Boolean).join(', '),profile.country].filter(Boolean).join('\n');}
async function save(db,ctx,input){
 const values={};for(const [key,[,max,label]] of Object.entries(fields)){
  if(input[key]!=null&&typeof input[key]!=='string')throw new ValidationError('Enter valid '+label.toLowerCase()+'.');
  const value=String(input[key]||'').trim();
  if(value.length>max||/[\u0000-\u001f\u007f]/.test(value)||key==='legalName'&&!value)
   throw new ValidationError(label+' must '+(key==='legalName'?'have between 1 and ':'have at most ')+max+' characters on one line.');
  values[key]=value;
 }
 const revision=Number(input.revision);if(!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload Company settings before saving.');
 return db.transaction(async c=>{
  const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(actor?.role!=='owner')throw new AuthorizationError('Only an inventory owner can change company details.');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['company-profile:'+ctx.workspaceId]);
  const before=await get(c,ctx.workspaceId);if(before.revision!==revision)throw new ValidationError('Company details changed. Reload this page before saving.');
  await c.query(`INSERT INTO workspace_company_profiles(workspace_id,legal_name,address_line1,address_line2,city,region,postal_code,country)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id) DO UPDATE SET
   legal_name=EXCLUDED.legal_name,address_line1=EXCLUDED.address_line1,address_line2=EXCLUDED.address_line2,
   city=EXCLUDED.city,region=EXCLUDED.region,postal_code=EXCLUDED.postal_code,country=EXCLUDED.country,
   revision=workspace_company_profiles.revision+1,updated_at=now()`,[ctx.workspaceId,...Object.keys(fields).map(key=>values[key])]);
  const after={...values,revision:revision+1};
  await require('./postgres-security-audit').record(c,ctx,{action:'Company details changed',before,after});return after;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={get,save,address};
