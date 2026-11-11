'use strict';

const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');

function sourceAmount(value,currency,label,{signed=false}={}) {
  let raw=String(value??'').trim();
  if(raw.startsWith('(')&&raw.endsWith(')'))raw='-'+raw.slice(1,-1).trim();
  const embedded=/^([A-Z]{3})\s+|\s+([A-Z]{3})$/i.exec(raw);
  if(embedded) {
    if((embedded[1]||embedded[2]).toUpperCase()!==currency)throw new ValidationError(label+' uses a different currency.');
    raw=raw.replace(embedded[0],'');
  }
  const symbol={USD:'$',CAD:'$',AUD:'$',NZD:'$',HKD:'$',SGD:'$',EUR:'€',GBP:'£',JPY:'¥',CNY:'¥'}[currency];
  if(symbol)raw=raw.replace(/^([-+]?)([$€£¥])\s*/,(match,sign,mark)=>mark===symbol?sign:match);
  if(/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw))raw=raw.replaceAll(',','');
  return money.toMinor(raw,currency,{label,signed});
}

function parse(value,currency,{explicit=false}={}) {
  const raw=String(value??'').trim();
  if(!raw)return null;
  if(!explicit&&!/[=;|\r\n]/.test(raw))return null;
  const entries=raw.replace(/^invoices?\s*:\s*/i,'').split(/[;|\r\n]+/).map(part=>part.trim()).filter(Boolean);
  if(entries.length===1&&!entries[0].includes('=')&&raw.includes(','))entries.splice(0,1,...raw.split(',').map(x=>x.trim()));
  const seen=new Set();
  const rows=entries.map(entry=>{
    const assignment=/^(.*?)\s*=\s*(.+)$/.exec(entry);
    const invoiceNumber=String(assignment?.[1]||entry).trim();
    if(!invoiceNumber||invoiceNumber.length>150||/[=;|\u0000-\u001f\u007f]/.test(invoiceNumber)||seen.has(invoiceNumber.toLowerCase())) {
      throw new ValidationError('List each exact invoice number once in the bank remittance.');
    }
    seen.add(invoiceNumber.toLowerCase());
    const amountMinor=assignment?sourceAmount(assignment[2],currency,'Remittance allocation'):null;
    if(amountMinor!==null&&amountMinor<=0)throw new ValidationError('Each stated remittance allocation must be positive.');
    return {invoiceNumber,amountMinor};
  });
  if(!rows.length||rows.some(r=>r.amountMinor===null)&&rows.some(r=>r.amountMinor!==null)) {
    throw new ValidationError('Give every named invoice its exact amount, or provide only the complete list of invoice references.');
  }
  return rows;
}

module.exports={sourceAmount,parse};
