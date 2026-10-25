'use strict';
// No caching, request rewriting or retries: origin pages remain authoritative.
// A reverse proxy can reject a navigation before our Express error page runs.
const page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Submission needs review · StockChief</title><style>body{font:18px/1.6 system-ui,sans-serif;background:#f5f5fa;color:#24243b;margin:0}main{max-width:640px;margin:8vh auto;padding:32px;background:white;border-radius:18px}a{color:#5146d9}button{font:inherit;background:#594cff;color:white;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}</style></head><body><main><a href="/">StockChief</a><h1>We couldn’t accept this submission.</h1><p>The website’s security service blocked the request before StockChief could display its usual response. Ordinary names and document text can sometimes trigger this by mistake.</p><p>Return to your form to review it. StockChief will not submit it again automatically.</p><button onclick="history.back()" type="button">Return to the form</button><p><a href="/support">Report this problem in StockChief</a> · support@stockchiefhq.com</p></main></body></html>';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 if(event.request.mode!=='navigate'||new URL(event.request.url).origin!==self.location.origin)return;
 event.respondWith((async()=>{const response=await fetch(event.request);
  if(response.status!==403||!String(response.headers.get('content-type')||'').includes('text/html'))return response;
  const body=await response.clone().text();
  // Keep StockChief's own permission/validation response and its explanation.
  if(/<title>[^<]*StockChief/i.test(body))return response;
  return new Response(page,{status:403,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
 })());
});
