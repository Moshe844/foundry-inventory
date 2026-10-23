'use strict';
// USPS content-qualified services are never generic cheapest-service offers.
// These are carrier service identifiers, not product/customer heuristics.
function allowed(rate,options={}){const service=String(rate.service||'').toLowerCase().replace(/[^a-z]/g,'');
 const required=service.includes('mediamail')?'MEDIA_MAIL':service.includes('librarymail')?'LIBRARY_MAIL':service.includes('boundprintedmatter')?'BOUND_PRINTED_MATTER':null;
 return !required||options.serviceEligibility===required;
}
module.exports={allowed};
