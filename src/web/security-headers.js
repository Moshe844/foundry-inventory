'use strict';
// Keep the existing inline controls working while restricting active content
// to StockChief and its configured hosted payment fields. Framing is denied
// on every response, including authentication, redirects, APIs and errors.
module.exports=function securityHeaders(req,res,next){
 res.set('Content-Security-Policy',"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline' https://cdn.cardknox.com https://js.stripe.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.stripe.com https://*.cardknox.com; frame-src https://cdn.cardknox.com https://js.stripe.com https://hooks.stripe.com; worker-src 'self' blob:");
 res.set('X-Frame-Options','DENY');res.set('X-Content-Type-Options','nosniff');
 res.set('Referrer-Policy','strict-origin-when-cross-origin');
 if(req.secure)res.set('Strict-Transport-Security','max-age=31536000');
 next();
};
