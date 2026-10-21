'use strict';
const {ValidationError}=require('./errors');

// Human-entered amounts have locale separators; provider decimal strings do
// not. Normalize the former before the existing exact currency calculation.
// Grouping must be structurally valid, never removed indiscriminately.
function decimal(value,{label='Amount',fractionDigits=2}={}){
  let text=String(value??'').trim().replace(/[$£€¥]/g,'').trim();
  if(!text)return '';
  if(!/^[+-]?[\d.,\s'’]+$/.test(text))throw new ValidationError(`${label} must be a number.`);
  text=text.replace(/^\+/,'');
  const fail=()=>{throw new ValidationError(`${label} has unclear number separators. Use an ungrouped decimal such as 1234.50.`);};
  // Spaces and apostrophes are grouping separators, not arbitrary whitespace.
  if(/[\s'’]/.test(text)){
    if(!/^-?\d{1,3}(?:[\s'’]\d{3})+(?:[.,]\d+)?$/.test(text))fail();
    text=text.replace(/[\s'’]/g,'');
  }
  const comma=text.includes(','),dot=text.includes('.');
  if(comma&&dot){
    const point=text.lastIndexOf(',')>text.lastIndexOf('.')?',':'.',group=point===','?'.':',';
    const parts=text.split(point);if(parts.length!==2||!/^\d+$/.test(parts[1]))fail();
    const whole=parts[0],escaped=group==='.'?'\\.':',';
    if(!new RegExp('^-?\\d{1,3}(?:'+escaped+'\\d{3})+$').test(whole))fail();
    return whole.split(group).join('')+'.'+parts[1];
  }
  if(comma){
    const parts=text.split(',');
    if(parts.length===2&&/^\d+$/.test(parts[1])&&parts[1].length!==3)return parts[0]+'.'+parts[1];
    if(parts.length===2&&parts[1].length===3&&fractionDigits===3)fail();
    if(!/^-?\d{1,3}(?:,\d{3})+$/.test(text))fail();
    return text.replace(/,/g,'');
  }
  if((text.match(/\./g)||[]).length>1){
    if(!/^-?\d{1,3}(?:\.\d{3})+$/.test(text))fail();
    return text.replace(/\./g,'');
  }
  if(!/^-?\d+(?:\.\d+)?$/.test(text))fail();
  return text;
}
module.exports={decimal};
