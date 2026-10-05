'use strict';
const config=require('../config');
const {ValidationError}=require('../domain/errors');
async function state(database){return (await database.query('SELECT * FROM commercial_release_control WHERE singleton=true')).rows[0];}
async function isOpen(database){const release=await state(database);return Boolean(config.commercial.checkoutEnabled&&release?.checkout_enabled
  &&release.economics_approved_at&&release.readiness_approved_at);}
async function assertCheckoutOpen(database,options={}){
  // Only isolated tests may exercise provider contracts while the live release is closed.
  if(options.testMode===true&&process.env.NODE_ENV==='test')return;
  if(!await isOpen(database))
    throw new ValidationError('Checkout is closed pending approval of the Commercial Readiness Report and final usage pricing.');
}
module.exports={state,isOpen,assertCheckoutOpen};
