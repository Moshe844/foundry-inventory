'use strict';
// Keep the existing inline controls working while restricting active content
// to StockChief and its configured hosted payment fields. Framing is denied
// on every response, including authentication, redirects, APIs and errors.
module.exports=function securityHeaders(req,res,next){
 res.set('Content-Security-Policy',"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' https://cdn.cardknox.com https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.stripe.com https://*.cardknox.com; frame-src https://cdn.cardknox.com https://js.stripe.com https://hooks.stripe.com; worker-src 'self' blob:");
 res.set('X-Frame-Options','DENY');res.set('X-Content-Type-Options','nosniff');
 res.set('Referrer-Policy','strict-origin-when-cross-origin');
 let callbackPath;try{callbackPath=decodeURIComponent(String(req.path||'')).replace(/\/+$/,'').toLowerCase();}catch{}
 if(callbackPath==='/settings/connections/quickbooks/callback'){
  res.set('Referrer-Policy','no-referrer');res.set('Cache-Control','no-cache, no-store');
  // Authentication, subscription and error middleware may respond before the
  // OAuth router. Their redirects/template bodies must not retain the code-
  // bearing URL or include it in an authentication return parameter.
  const cleanFailure=()=>{
   res.removeHeader('Content-Type');res.removeHeader('Content-Length');
   return res.status(302).location('/settings/connections/quickbooks/authorization-result').end();
  };
  res.redirect=cleanFailure;res.send=cleanFailure;
 }
 if(req.secure)res.set('Strict-Transport-Security','max-age=31536000');
 next();
};

// Public marketing pages have external scripts only. Their policy can reject
// inline script without changing the authenticated application's controls.
module.exports.publicPage=function publicPage(res){
 res.set('Content-Security-Policy',"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; form-action 'self'; worker-src 'self' blob:");
 res.set('Referrer-Policy','no-referrer');
};
