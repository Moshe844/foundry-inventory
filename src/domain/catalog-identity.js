'use strict';
function detailsVersion(item){return require('node:crypto').createHash('sha256').update(JSON.stringify([
 item.name,item.base_code||null,item.description||null,item.unit_label||'unit',Number(item.allow_negative||0),Number(item.quantity_precision||0),String(item.quantity_increment??1),item.secondary_unit_label||null,Number(item.secondary_precision??3),String(item.secondary_increment??0.001)
])).digest('hex');}
const {ValidationError}=require('./errors');
const codeKey=value=>String(value??'').trim().toLowerCase();
function unitLabel(value){const text=String(value??'').trim()||'unit';if(text.length>40)throw new ValidationError('Unit of measure must be 40 characters or fewer.');return text;}
module.exports={codeKey,unitLabel,detailsVersion};
