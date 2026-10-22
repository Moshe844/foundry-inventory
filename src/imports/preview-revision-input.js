'use strict';
const stable=value=>JSON.stringify(Object.fromEntries(Object.entries(value||{}).sort(([a],[b])=>a.localeCompare(b))));
// Retaining the current tracking choices is not a request to reread the file.
// Keep this shortcut narrow: all other review inputs still use full validation.
function unchangedTracking(plan,input){
 if(!input.trackingReview||typeof input.trackingReview!=='object'||Array.isArray(input.trackingReview))return false;
 if(Object.keys(input.trackingReview).some(k=>!['serial','lot'].includes(k)))return false;
 const previous=plan.transformations.trackingReview||{};
 if(['serial','lot'].some(mode=>(input.trackingReview[mode]||'source')!==(previous[mode]||'source')))return false;
 if(input.fieldMappings!==undefined&&stable(input.fieldMappings)!==stable(plan.fieldMappings))return false;
 if(input.defaultLocationId!==undefined&&(input.defaultLocationId||null)!==(plan.defaultLocationId||null))return false;
 for(const key of ['importMode','allowPartialImport','confirmCatalogOnly'])if(input[key]!==undefined&&input[key]!==plan.transformations[key])return false;
 if(input.confirmImageReading||input.confirmWorksheetScope)return false;
 for(const key of ['quantityOverrides','codeOverrides','moneyOverrides','documentRowRoles'])if(Object.keys(input[key]||{}).length)return false;
 if(Object.entries(input.locationMappings||{}).some(([key,value])=>value!==plan.locationMappings[key]))return false;
 const locations=new Map((plan.transformations.proposedLocations||[]).map(row=>[row.source,row]));
 if(Object.entries(input.proposedLocations||{}).some(([key,value])=>!locations.has(key)||Object.entries(value).some(([field,v])=>v!==locations.get(key)[field])))return false;
 return true;
}
module.exports={unchangedTracking};
