'use strict';
function exclusion(data){
 if(data.inventoryCountUnavailable)return String(data.inventoryCountUnavailable);
 if(data.isGiftCard)return 'Gift cards are financial products, not physical inventory.';
 if(data.virtual===true)return 'This is a virtual product, not physical inventory.';
 if(data.tracked===false)return 'The provider does not track physical inventory for this product.';
 if(data.productStatus&&data.productStatus!=='ACTIVE')return 'This product is '+String(data.productStatus).toLowerCase()+' in the provider.';
 if(data.active===false)return 'This provider location is inactive.';
 return null;
}
module.exports={exclusion};
