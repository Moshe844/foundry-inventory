'use strict';
const {ValidationError}=require('../domain/errors');
const subKinds=Object.freeze(['zone','aisle','shelf','bin','dock','staging']);
function sublocationPredicate(alias='location'){if(!/^[a-z_]+$/.test(alias))throw Error('Invalid internal location alias');return `(${alias}.kind IN (${subKinds.map(k=>"'"+k+"'").join(',')}) OR (${alias}.kind='other' AND ${alias}.parent_location_id IS NOT NULL))`;}
function meterFor(value){return subKinds.includes(value.kind)||value.kind==='other'&&Boolean(value.parentLocationId??value.parent_location_id)?'sublocations':'locations';}
async function assertChange(db,ctx,before,after){const ent=require('./entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),subscription=await ent.subscriptionFor(db,scope.accountId),split=subscription?.plan_configuration?.locationAccounting==='sites_and_sublocations';
 const meter=split?meterFor(after):'locations',parent=after.parentLocationId??after.parent_location_id;
 if(split&&meter==='sublocations'&&!parent)throw new ValidationError('Choose the warehouse or parent area that contains this bin or zone.');
 if(split&&meter==='locations'&&parent)throw new ValidationError('A physical warehouse or site cannot be inside another location. Choose a bin or zone for an area inside a warehouse.');
 const active=Number(after.is_active??1)===1,previousActive=before&&Number(before.is_active)===1,previousMeter=before?(split?meterFor(before):'locations'):null;
 if(active&&(!previousActive||previousMeter!==meter))await ent.assertMeterCapacity(db,scope,meter,1);
 return {meter,split};
}
module.exports={subKinds,sublocationPredicate,meterFor,assertChange};
