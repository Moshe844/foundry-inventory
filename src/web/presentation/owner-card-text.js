'use strict';
// Presentation only. Source records, audit evidence and navigation IDs stay intact.
function ownerCardText(value){return String(value??'')
 .replace(/gid:\/\/shopify\/[A-Za-z]+\/[A-Za-z0-9/?=&_-]+/gi,'Shopify record')
 .replace(/\b(?:re|pi|ch|evt|gid)_[A-Za-z0-9]{8,}\b/g,'payment record')
 .replace(/\b(?:Shopify\s+)?refund(?:\s+(?:ID|reference))?\s*[:#]?\s*\d{8,}\b/gi,'Refund requiring review')
 .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,'record')
 .replace(/\bwebhook(?:s)?\b/gi,'incoming updates')
 .replace(/\boutbox\b/gi,'pending updates')
 .replace(/\bcanonical\s+/gi,'')
 .replace(/\bprovider read[- ]?back\b/gi,'confirmation from the connected service')
 .replace(/\bsynchroni[sz]ation\b|\bsync\b/gi,'connection update');}
module.exports={ownerCardText};
