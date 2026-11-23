'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const site=require('../../src/web/presentation/public-site');
test('public sitemap uses only the configured HTTPS origin and excludes account data',()=>{
 for(const value of [undefined,'request','http://example.test','https://user:secret@example.test','javascript:alert(1)'])assert.equal(site.canonicalOrigin(value),'https://app.stockchiefhq.com');
 assert.equal(site.canonicalOrigin('https://marketing.example.test/path?token=private'),'https://marketing.example.test');
 const xml=site.sitemap('https://marketing.example.test/path?token=private'),urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>new URL(match[1]));
 assert(urls.length>=10);assert.equal(new Set(urls.map(url=>url.href)).size,urls.length);
 assert(urls.every(url=>url.origin==='https://marketing.example.test'&&url.search===''));
 assert(urls.some(url=>url.pathname==='/pricing'));assert.doesNotMatch(xml,/token|settings|billing|inventory|register|login/);
});
test('public page CSP rejects inline scripts without changing authenticated controls',()=>{
 const policies=new Map(),res={set:(key,value)=>policies.set(key,value)};
 const headers=require('../../src/web/security-headers');headers({path:'/inventory',secure:true},res,()=>{});
 assert.match(policies.get('Content-Security-Policy'),/script-src [^;]*'unsafe-inline'/);
 assert.equal(policies.get('X-Frame-Options'),'DENY');assert.equal(policies.get('Strict-Transport-Security'),'max-age=31536000');
 headers.publicPage(res);assert.match(policies.get('Content-Security-Policy'),/script-src 'self';/);
 assert.doesNotMatch(policies.get('Content-Security-Policy'),/script-src [^;]*'unsafe-inline'/);
 assert.equal(policies.get('Referrer-Policy'),'no-referrer');assert.equal(policies.get('X-Frame-Options'),'DENY');
});
