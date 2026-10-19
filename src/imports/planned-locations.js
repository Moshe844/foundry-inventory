'use strict';
const {ValidationError}=require('../domain/errors');
const {LOCATION_KIND_IDS}=require('../domain/constants');
function proposals(sheet,mappings,context,input={}){
 const proposed=new Map(),names=new Set(),overrides=input.proposedLocations||{};
 if(mappings.location===undefined)return [];
 for(const row of sheet.rows){
  const source=String(row.cells[mappings.location]??'').trim();
  if(!source||source.length>120)continue;
  if(input.locationMappings?.[source]||context.locationByName.has(source.toLowerCase()))continue;
  const key=source.toLowerCase();
  if(proposed.has(key))continue;
  const choice=overrides[source]||{},name=String(choice.name||source).trim(),kind=choice.kind||'other';
  if(!name||name.length>120||!LOCATION_KIND_IDS.includes(kind))throw new ValidationError('Each proposed location needs a name of at most 120 characters and a supported location type.');
  if(names.has(name.toLowerCase()))throw new ValidationError('Two source locations cannot silently become one location. Match them explicitly to an existing location instead.');
  if(context.locationByName.has(name.toLowerCase()))throw new ValidationError('This proposed name already belongs to a location. Choose its existing match instead.');
  proposed.set(key,{source,name,kind});
  names.add(name.toLowerCase());
 }
 return [...proposed.values()];
}
function withProposals(context,proposed){
 const locationByName=new Map(context.locationByName);
 for(const row of proposed)locationByName.set(row.source.toLowerCase(),[{id:null,name:row.name,proposed:true}]);
 return {...context,locationByName};
}
async function assertOwner(database,ctx,proposed){
 if(!proposed.length)return;
 const user=(await database.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(user?.role!=='owner')throw new (require('../domain/errors').AuthorizationError)('An owner must approve imports that create new locations.');
}
async function materialize(database,ctx,proposed){
 await assertOwner(database,ctx,proposed);const ids=new Map();
 for(const row of proposed){
  const current=await database.query('SELECT id FROM locations WHERE workspace_id=$1 AND lower(name)=lower($2)',[ctx.workspaceId,row.name]);
  if(current.rows.length)throw new ValidationError('A proposed location was created or renamed after approval. Recalculate and review the import again.');
  const location=await require('../domain/postgres-location-service').createLocationInTransaction(database,ctx,{name:row.name,kind:row.kind});
  ids.set(row.name,location.id);
 }
 return ids;
}
module.exports={proposals,withProposals,assertOwner,materialize};
