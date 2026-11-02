'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('authenticator setup image decodes to the exact local account, secret and TOTP parameters without network access',async t=>{
 const secret=require('../../src/domain/totp').generate(),email='owner+qr@example.test';t.mock.method(global,'fetch',()=>{throw Error('A QR setup secret must never leave this process');});
 const src=await require('../../src/domain/totp-provisioning').dataUrl(secret,email);assert.match(src,/^data:image\/svg\+xml;base64,/);
 const {createCanvas,loadImage}=require('@napi-rs/canvas'),canvas=createCanvas(512,512),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,512,512);ctx.drawImage(await loadImage(Buffer.from(src.split(',')[1],'base64')),0,0,512,512);
 const {default:decode}=await import('qr/decode.js'),uri=new URL(decode(ctx.getImageData(0,0,512,512)));
 assert.equal(uri.protocol,'otpauth:');assert.equal(uri.hostname,'totp');assert.equal(decodeURIComponent(uri.pathname.slice(1)),'StockChief:'+email);assert.equal(uri.searchParams.get('secret'),secret);assert.equal(uri.searchParams.get('issuer'),'StockChief');assert.equal(uri.searchParams.get('algorithm'),'SHA1');assert.equal(uri.searchParams.get('digits'),'6');assert.equal(uri.searchParams.get('period'),'30');
});
