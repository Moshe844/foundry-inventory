'use strict';
const {ValidationError}=require('../../domain/errors');
const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function validate(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>3)throw new ValidationError('Choose up to three delivery photo copies.');
 return value.map(p=>{
  // Delivery photos (job 46), statement and supplier pack PDFs (jobs 81, 164)
  // and the accountant's year-end workbook (job 165).
  const pdf=p?.contentType==='application/pdf',workbook=p?.contentType===XLSX,document=pdf||workbook;
  if(!p||!Buffer.isBuffer(p.content)||!p.content.length||p.content.length>(document?2097152:614400)||!['image/jpeg','image/png','application/pdf',XLSX].includes(p.contentType)||!/^[-a-zA-Z0-9_.]{1,120}$/.test(p.filename)||pdf&&p.content.subarray(0,5).toString()!=='%PDF-'
    ||workbook&&(p.content.length<4||p.content.readUInt32LE(0)!==0x04034b50||!/\.xlsx$/.test(p.filename)))
    throw new ValidationError(workbook?'This Excel attachment needs review before sending.':pdf?'This PDF attachment needs review before sending.':'This photo attachment needs review before sending.');
  return p;
 });
}
function mime(message){
 const photos=validate(message.attachments);
 if(!photos.length)return null;
 for(const value of [message.recipient,message.subject,message.id||''])if(/[\r\n]/.test(String(value)))throw new ValidationError('Email headers must stay on one line.');
 const boundary='stockchief-'+require('node:crypto').randomBytes(24).toString('hex');
 const lines=[`To: ${message.recipient}`,'Subject: =?UTF-8?B?'+Buffer.from(message.subject).toString('base64')+'?=',...(message.id?[`X-StockChief-Message: ${message.id}`]:[]),'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`,'',`--${boundary}`,'Content-Type: text/plain; charset="UTF-8"','Content-Transfer-Encoding: base64','',Buffer.from(message.body).toString('base64').match(/.{1,76}/g).join('\r\n')];
 for(const p of photos)lines.push(`--${boundary}`,`Content-Type: ${p.contentType}`,`Content-Disposition: attachment; filename="${p.filename}"`,'Content-Transfer-Encoding: base64','',p.content.toString('base64').match(/.{1,76}/g).join('\r\n'));
 lines.push(`--${boundary}--`,'');return lines.join('\r\n');
}
function graph(value){return validate(value).map(p=>({'@odata.type':'#microsoft.graph.fileAttachment',name:p.filename,contentType:p.contentType,contentBytes:p.content.toString('base64')}));}
module.exports={validate,mime,graph};
