'use strict';
function exclusion(data){
 if(data.isGiftCard)return 'Gift cards are financial products, not physical inventory.';
 if(data.virtual===true)return 'This is a virtual product, not physical inventory.';
 if(data.productStatus&&data.productStatus!=='ACTIVE')return 'This product is '+String(data.productStatus).toLowerCase()+' in the provider.';
 if(data.active===false)return 'This provider location is inactive.';
 return null;
}
// A physical catalogue entry can exist even when the provider does not keep
// stock. Missing stock evidence limits receipts; it does not erase the SKU.
function openingCounts(data){
 if(data.tracked===false||data.inventoryCountUnavailable||exclusion(data))return [];
 return Array.isArray(data.inventoryCounts)?data.inventoryCounts:[];
}
module.exports={exclusion,openingCounts};
