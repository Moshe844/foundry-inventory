'use strict';
function message(status,detail,provider='The shipping provider'){
 const code=Number(status);
 if(code===401||code===403)return provider+' could not authorize this account. Check the key and whether it belongs to the selected test or live environment.';
 if(code===429)return provider+' is temporarily limiting requests. Wait a moment before trying again.';
 if(code>=500)return provider+' is temporarily unavailable. Check the original operation before repeating a purchase.';
 const text=typeof detail==='string'?detail:'';
 if(!text)return provider+' could not accept these shipment details. Check the address, package measurements and carrier service.';
 return text.replace(/\bHTTP\s+[1-5]\d{2}\b/gi,'provider response').replace(/\breturned\s+[1-5]\d{2}\b/gi,'could not accept the request').replace(/\(([1-5]\d{2})\)/g,'').trim();
}
module.exports={message};
