'use strict';
async function dataUrl(secret,email){
 require('./totp').decode(secret);
 const uri=new URL('otpauth://totp/'+encodeURIComponent('StockChief:'+String(email).trim()));
 for(const [key,value]of Object.entries({secret,issuer:'StockChief',algorithm:'SHA1',digits:'6',period:'30'}))uri.searchParams.set(key,value);
 const {default:encode}=await import('qr'),svg=encode(uri.href,'svg',{ecc:'medium',border:4,scale:4});
 return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
module.exports={dataUrl};
