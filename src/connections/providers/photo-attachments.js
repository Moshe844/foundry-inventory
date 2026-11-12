'use strict';
const {ValidationError}=require('../../domain/errors');
function validate(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>3)throw new ValidationError('Choose up to three delivery photo copies.');
 return value.map(p=>{
  // Delivery photos (job 46) and one statement PDF (job 81).
  const document=p?.contentType==='application/pdf';
  if(!p||!Buffer.isBuffer(p.content)||!p.content.length||p.content.length>(document?2097152:614400)||!['image/jpeg','image/png','application/pdf'].includes(p.contentType)||!/^[-a-zA-Z0-9_.]{1,120}$/.test(p.filename)||document&&p.content.subarray(0,5).toString()!=='%PDF-')throw new ValidationError(document?'This PDF attachment needs review before sending.':'This photo attachment needs review before sending.');
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
