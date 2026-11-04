'use strict';
const COMMON=Object.freeze(['America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles','America/Anchorage','Pacific/Honolulu']);
function ordered(...first){return [...new Set([...first.filter(Boolean),...COMMON,...Intl.supportedValuesOf('timeZone'),'UTC'])];}
// Every timestamp a person reads inside a sentence, in the business's own zone.
const STAMP=/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
function readableTimes(text,timeZone='UTC'){
 if(typeof text!=='string'||!text.includes('T'))return text;
 const format=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone});
 return text.replace(STAMP,stamp=>{const at=new Date(stamp);return Number.isNaN(at.getTime())?stamp:format.format(at).replace(/\u202f/g,' ');});
}
module.exports={COMMON,ordered,readableTimes};
