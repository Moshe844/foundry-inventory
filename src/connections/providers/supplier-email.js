'use strict';

// Metadata for the legacy documented supplier-email endpoint.  It participates
// in the same provider registry as Gmail and Microsoft 365 so no screen falls
// back to the unrelated "Custom business system" label.
module.exports = Object.freeze({
  type:'supplier_email',
  integrationClass:'email',
  metadata() {
    return { type:'supplier_email', name:'Supplier email', mark:'Mail', category:'email',
      authMode:'token', description:'Receive approved supplier messages and documents through Foundry’s documented email endpoint.',
      provides:['supplier messages','purchasing documents','authorized supplier email'], available:true };
  },
});
