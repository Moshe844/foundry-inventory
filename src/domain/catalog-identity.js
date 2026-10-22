'use strict';
const {ValidationError}=require('./errors');
const codeKey=value=>String(value??'').trim().toLowerCase();
function unitLabel(value){const text=String(value??'').trim()||'unit';if(text.length>40)throw new ValidationError('Unit of measure must be 40 characters or fewer.');return text;}
module.exports={codeKey,unitLabel};
