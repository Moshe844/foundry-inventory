'use strict';
const {randomBytes}=require('node:crypto');
const alphabet='0123456789abcdefghjkmnpqrstvwxyz';
function encode(value,length){let result='';for(let n=0;n<length;n++){result=alphabet[Number(value&31n)]+result;value>>=5n;}return result;}
// The same cryptographic random bytes, drawn 4,000 at a time. A bulk import
// creates hundreds of thousands of IDs, and one system call per ID showed up
// as seconds of a large import. Each byte is still used exactly once.
let pool=Buffer.alloc(0),offset=0;
function randomTen(){if(offset+10>pool.length){pool=randomBytes(4000);offset=0;}const hex=pool.toString('hex',offset,offset+10);offset+=10;return hex;}
// ULID layout: 48-bit millisecond time and 80 independent random bits. New
// append-only receipts stay near the end of their ID indexes as history grows.
// Existing IDs remain valid. These are record identifiers, never credentials.
function newAppendId(prefix){
 const time=Date.now();if(!Number.isSafeInteger(time)||time<0||time>281474976710655)throw new RangeError('Record timestamp is outside the supported range.');
 return prefix+'_'+encode(BigInt(time),10)+encode(BigInt('0x'+randomTen()),16);
}
module.exports={newAppendId};
