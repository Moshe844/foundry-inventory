'use strict';

// Whether a password sign-in asks for a code emailed to the account.
// STOCKCHIEF_SIGN_IN_CODE=off turns it off (for example on a copy used by
// automated browser checks); =on forces it on. Otherwise it is on wherever
// the app can send email, and off in automated tests.
function enabled(env=process.env.NODE_ENV){
  const setting=String(process.env.STOCKCHIEF_SIGN_IN_CODE||'').trim().toLowerCase();
  if(['off','0','false','no'].includes(setting))return false;
  if(['on','1','true','yes','required'].includes(setting))return true;
  return env!=='test'&&Boolean(process.env.RESEND_API_KEY);
}

module.exports={enabled};
