'use strict';
const {ValidationError}=require('../domain/errors'),{codeKey}=require('../domain/catalog-identity');
// Resolve an exact child reference only inside the already-authorized parent.
// Canonical IDs take priority. Product IDs and codes are explicit alternative
// references, never a global search or a fuzzy name match.
function resolve(rows,value,{label='product line'}={}){
 const ref=String(value||'').trim();if(!ref)throw new ValidationError('Choose an exact '+label+'.');
 const byId=rows.filter(r=>r.id===ref);if(byId.length===1)return byId[0].id;
 const matches=rows.filter(r=>r.sku_id===ref||Boolean(r.code)&&codeKey(r.code)===codeKey(ref));
 if(matches.length>1)throw new ValidationError('This reference matches more than one '+label+'. Choose its exact line ID.');
 if(matches.length!==1)throw new ValidationError('This reference is not an exact '+label+' on the selected parent record.');return matches[0].id;
}
module.exports={resolve};
