'use strict';
const {randomBytes}=require('node:crypto');
const alphabet='0123456789abcdefghjkmnpqrstvwxyz';
function encode(value,length){let result='';for(let n=0;n<length;n++){result=alphabet[Number(value&31n)]+result;value>>=5n;}return result;}
// ULID layout: 48-bit millisecond time and 80 independent random bits. New
// append-only receipts stay near the end of their ID indexes as history grows.
// Existing IDs remain valid. These are record identifiers, never credentials.
function newAppendId(prefix){
 const time=Date.now();if(!Number.isSafeInteger(time)||time<0||time>281474976710655)throw new RangeError('Record timestamp is outside the supported range.');
 return prefix+'_'+encode(BigInt(time),10)+encode(BigInt('0x'+randomBytes(10).toString('hex')),16);
}
module.exports={newAppendId};
