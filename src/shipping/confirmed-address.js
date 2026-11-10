'use strict';
const countries=new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

// These are explicit saved fields, not a guess from an international text address.
function parse(raw,fields){
 const result={raw,name:null,line1:null,line2:null,city:null,state:null,postalCode:null,country:null,complete:false,missing:[]};
 if(!fields||Array.isArray(fields)||typeof fields!=='object'){result.missing=['confirmed address fields'];return result;}
 for(const key of ['line1','line2','city','state','postalCode','country']){
  const value=fields[key];if(value!=null&&typeof value!=='string'||String(value||'').length>200||/[\u0000-\u001f\u007f]/.test(String(value||''))){result.missing=['valid confirmed address fields'];return result;}
  result[key]=String(value||'').trim()||null;
 }
 result.country=String(result.country||'').toUpperCase();
 if(!countries.has(result.country))result.missing.push('two-letter country code');
 if(!result.line1)result.missing.push('street');if(!result.city)result.missing.push('city');
 if(['US','CA','GB'].includes(result.country)&&!result.postalCode)result.missing.push('postcode');
 if(result.country==='US'){
  if(!require('./address').STATES.has(String(result.state||'').toUpperCase()))result.missing.push('US state code');
  if(result.postalCode&&!/^\d{5}(?:-\d{4})?$/.test(result.postalCode))result.missing.push('valid US postcode');
 }
 if(result.country==='CA'){
  if(!new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' ')).has(String(result.state||'').toUpperCase()))result.missing.push('Canadian province code');
  if(result.postalCode&&!/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(result.postalCode))result.missing.push('valid Canadian postcode');
 }
 const canonical=[result.line1,result.line2,result.city+(result.state?', '+result.state:'')+(result.postalCode?' '+result.postalCode:''),result.country].filter(Boolean).join('\n');
 if(canonical!==raw)result.missing.push('matching confirmed address text');
 result.complete=result.missing.length===0;return result;
}
module.exports={parse,countries};
