'use strict';
// RFC 4226/6238, using Node's HMAC implementation. Secrets use standard base32
// for authenticator-app provisioning; verification accepts one adjacent step.
const crypto=require('crypto'),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encode(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode(text){if(!/^[A-Z2-7]{16,128}$/.test(text))throw Error('Invalid authenticator secret.');let bits=0,value=0,out=[];for(const char of text){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
function code(secret,counter,{digits=6}={}){if(!Number.isSafeInteger(counter)||counter<0||![6,8].includes(digits))throw Error('Invalid authenticator counter.');const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter));const digest=crypto.createHmac('sha1',decode(secret)).update(bytes).digest(),offset=digest.at(-1)&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');}
function verify(secret,supplied,{now=Date.now(),afterCounter=-1}={}){const candidate=String(supplied||'').replace(/\s/g,'');if(!/^\d{6}$/.test(candidate))return null;const current=Math.floor(now/30000);for(const counter of [current,current-1,current+1])if(counter>=0&&counter>Number(afterCounter)&&crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(code(secret,counter))))return counter;return null;}
module.exports={encode,decode,code,verify,generate:()=>encode(crypto.randomBytes(20))};
