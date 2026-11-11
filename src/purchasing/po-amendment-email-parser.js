'use strict';

const {ValidationError}=require('../domain/errors');
const {parseDelimited}=require('../imports/parser');
const exact=require('../domain/exact-quantity');
const money=require('../domain/currency');

const subjectPattern=/^(?:re:\s*)*(?:purchase order|po) (?:amendment|change)\s*[:#-]?\s+([a-z0-9][a-z0-9._/-]{0,79})[.!]?$/i;
const fields=new Map([
  ['line','line'],['sku','sku'],['supplier sku','supplierSku'],['stock unit','stockUnit'],['weight unit','weightUnit'],
  ['remaining quantity','quantity'],['remaining weight','secondary'],['unit price','price'],['price basis','basis'],
]);
const quantityFields=['quantity','secondary','price'];
const unclear=()=>new ValidationError('Review the original supplier email. An exact PO number, currency, line or product code, and clearly labelled revised quantities, units and prices are required.');

function subject(value){
  return subjectPattern.exec(String(value||'').trim())?.[1]||null;
}

function cleanLine(value){
  return /^(?:hello|hi|thanks|thank you|regards|best regards)[,.!]?$/i.test(value);
}

function parse(title,body){
  const order=subject(title);
  if(!order||typeof body!=='string'||body.length>60000)throw unclear();
  const lines=require('../connections/reply-triage').prose(body).split(/\r?\n/)
    .map(line=>line.trim()).filter(line=>line&&!cleanLine(line));
  const details={};
  let start=0;
  while(start<lines.length){
    const field=/^(PO|Currency|Expected delivery)\s*:\s*(.+)$/i.exec(lines[start]);
    if(!field)break;
    const key=field[1].toLowerCase();
    if(Object.hasOwn(details,key))throw unclear();
    details[key]=field[2].trim();
    start++;
  }
  if(details.po&&details.po.toLowerCase()!==order.toLowerCase())throw unclear();
  if(!/^[A-Z]{3}$/.test(details.currency||''))throw unclear();
  const date=details['expected delivery']||null;
  if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||
    new Date(date).toISOString().slice(0,10)!==date))throw unclear();
  const header=lines[start]||'';
  const delimiter=header.includes('|')?'|':header.includes('\t')?'\t':',';
  const grid=parseDelimited(lines.slice(start).join('\n'),delimiter);
  if(grid.length<2||grid.length>251)throw unclear();
  const keys=grid[0].map(key=>fields.get(String(key).trim().toLowerCase()));
  if(keys.some(key=>!key)||new Set(keys).size!==keys.length||
    !keys.some(key=>['line','sku','supplierSku'].includes(key))||
    !keys.some(key=>quantityFields.includes(key)))throw unclear();
  const rows=grid.slice(1).map(values=>{
    if(values.length!==keys.length)throw unclear();
    const row=Object.fromEntries(keys.map((key,index)=>[key,String(values[index]||'').trim()]));
    const invalidLine=row.line&&!/^[1-9]\d{0,5}$/.test(row.line);
    const missingIdentity=!row.line&&!row.sku&&!row.supplierSku;
    const missingChanges=!quantityFields.some(key=>row[key]);
    const missingUnit=row.quantity&&!row.stockUnit||row.secondary&&!row.weightUnit;
    const unclearPrice=row.price&&!['stock','weight'].includes(row.basis?.toLowerCase());
    if(invalidLine||missingIdentity||missingChanges||missingUnit||unclearPrice)throw unclear();
    for(const key of ['quantity','secondary'])if(row[key])row[key]=exact.canonical(row[key],{scale:6});
    if(row.price)row.price=money.fromMinor(money.userToMinor(row.price,details.currency,{label:'Supplier unit price'}),details.currency);
    return row;
  });
  return {order,currency:details.currency,date,rows};
}

module.exports={subject,parse};
