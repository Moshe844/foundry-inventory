'use strict';
// Replay is a durable transport receipt, not model working context. Retain its
// exact bytes without rewriting the large, repetitive SSE stream on every
// subsequent goal checkpoint. Legacy plain packets remain readable.
const {gzipSync,gunzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const MAX_BODY=8*1024*1024; // unchanged provider-response bound
const hash=body=>createHash('sha256').update(body).digest('hex');
function invalid(){throw Error('CODEX_REPLAY_PAYLOAD_INVALID');}
function body(packet){
 if(packet?.bodyEncoding===undefined){
  if(typeof packet?.body!=='string'||Buffer.byteLength(packet.body)>MAX_BODY)invalid();
  return packet.body;
 }
 if(packet.bodyEncoding!=='gzip-base64'||typeof packet.bodyGzip!=='string'||
  !Number.isSafeInteger(packet.bodyBytes)||packet.bodyBytes<0||packet.bodyBytes>MAX_BODY||
  !/^[a-f0-9]{64}$/.test(packet.bodySha256||''))invalid();
 let bytes;try{bytes=gunzipSync(Buffer.from(packet.bodyGzip,'base64'),{maxOutputLength:MAX_BODY});}catch{invalid();}
 if(bytes.length!==packet.bodyBytes||hash(bytes)!==packet.bodySha256)invalid();
 return bytes.toString('utf8');
}
function pack(packet){
 const value=structuredClone(packet),text=body(value);
 if(value.bodyEncoding||Buffer.byteLength(text)<16384)return value;
 const bytes=Buffer.from(text,'utf8'),compressed=gzipSync(bytes,{level:1});
 if(compressed.length*4/3>=bytes.length)return value;
 delete value.body;
 return {...value,bodyEncoding:'gzip-base64',bodyBytes:bytes.length,bodySha256:hash(bytes),bodyGzip:compressed.toString('base64')};
}
function unpack(packet){
 const value=structuredClone(packet),text=body(value);
 for(const key of ['bodyEncoding','bodyBytes','bodySha256','bodyGzip'])delete value[key];
 return {...value,body:text};
}
module.exports={pack,unpack,body};
