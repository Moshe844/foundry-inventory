'use strict';
// Explicit offline model output; canonical resolution, permissions, review and
// execution still run normally. This is never registered by the application.
module.exports=function receiptIntent({item,quantity,location}){const intent={lines:[{
 actionType:'receive',item,quantity,destinationLocation:location,sourceLocation:'',variant:'',lotCode:'',serials:[],adjustmentTarget:-1,reasonCode:'',terminologyKey:'',terminologyValue:'',productName:'',productCode:'',variantAxes:'',unitLabel:'',supplier:'',purchaseUnit:'',
}],clarifyingQuestion:'',unsupportedReason:''};return require('./fake-provider').fakeProvider(request=>request.schemaName==='manager_intent'?{capabilityId:'inventory.record-movement',intentClass:'INVENTORY_ACTION',confidence:'high',goal:'Record the supplied receipt',reason:'The fixture explicitly records incoming stock.',resolvedReference:'',clarifyingQuestion:'',parameters:{fromText:'',toText:'',transformMode:'',documentReference:''}}:intent);};
