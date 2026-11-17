'use strict';

// Files attached to a support conversation: a pasted screenshot, a photo, a PDF,
// a spreadsheet or a text file. The type is read from the file's own bytes, never
// from its name or what the browser claimed, and that type is what the file is
// served as. Images open in the page; everything else downloads.

const crypto=require('node:crypto');
const {newId}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {has}=require('../db/schema-installed');

const TABLE='support_attachments';
const MAX_FILES=5,MAX_BYTES=10*1024*1024,MAX_TOTAL=20*1024*1024,DAILY_BYTES=200*1024*1024;
const IMAGES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const ACCEPT='image/*,.pdf,.txt,.csv,.log,.xlsx,.docx';

const starts=(buffer,bytes,offset=0)=>bytes.every((b,i)=>buffer[offset+i]===b);
const ascii=(buffer,text,offset=0)=>buffer.length>=offset+text.length&&buffer.toString('latin1',offset,offset+text.length)===text;
const extension=name=>(/\.([a-z0-9]{1,8})$/i.exec(name||'')?.[1]||'').toLowerCase();

// The file's real type, from its first bytes (and, for zip and text files, its name too).
function sniff(buffer,name){
  if(starts(buffer,[0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))return 'image/png';
  if(starts(buffer,[0xFF,0xD8,0xFF]))return 'image/jpeg';
  if(ascii(buffer,'GIF87a')||ascii(buffer,'GIF89a'))return 'image/gif';
  if(ascii(buffer,'RIFF')&&ascii(buffer,'WEBP',8))return 'image/webp';
  if(ascii(buffer,'ftyp',4)&&['heic','heix','mif1','msf1','hevc'].includes(buffer.toString('latin1',8,12)))return 'image/heic';
  if(ascii(buffer,'%PDF-'))return 'application/pdf';
  const ext=extension(name);
  if(starts(buffer,[0x50,0x4B,0x03,0x04])){
    if(ext==='xlsx')return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if(ext==='docx')return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return null;
  }
  if(['txt','csv','log'].includes(ext)){
    const head=buffer.subarray(0,8192);
    if(head.includes(0))return null;
    try{new TextDecoder('utf-8',{fatal:true}).decode(head.length===buffer.length?head:head.subarray(0,head.length-4));}catch{return null;}
    return ext==='csv'?'text/csv':'text/plain';
  }
  return null;
}

// A name to show and to offer when saving: no folders, no control characters.
function cleanName(name,type){
  let base=String(name||'').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|]/g,'').replace(/\s+/g,' ').trim();
  if(!base)base=type.startsWith('image/')?'Screenshot':'Attachment';
  if(base.length>180){const ext=extension(base);base=base.slice(0,170-(ext?ext.length+1:0)).trim()+(ext?'.'+ext:'');}
  return base;
}

function size(bytes){const n=Number(bytes);return n<1024?n+' bytes':n<1024*1024?Math.round(n/1024)+' KB':(n/1024/1024).toFixed(n<10*1024*1024?1:0)+' MB';}

// Checks the files of one message before anything is saved, and returns them ready to save.
function prepare(files){
  const list=(Array.isArray(files)?files:[]).filter(file=>file&&file.buffer&&file.buffer.length);
  if(list.length>MAX_FILES)throw new ValidationError(`Attach up to ${MAX_FILES} files to one message.`);
  let total=0;
  return list.map(file=>{
    const name=String(file.filename||file.name||'');
    if(file.buffer.length>MAX_BYTES)throw new ValidationError(`${cleanName(name,'')} is larger than 10 MB. Attach a smaller file or a screenshot of the part that matters.`);
    total+=file.buffer.length;
    if(total>MAX_TOTAL)throw new ValidationError('These files are more than 20 MB together. Send them in two messages.');
    const type=sniff(file.buffer,name);
    if(!type)throw new ValidationError(`${cleanName(name,'')||'That file'} can't be attached. Attach a picture, PDF, spreadsheet (.xlsx or .csv), Word document or text file.`);
    return {name:cleanName(name,type),type,bytes:file.buffer,sha256:crypto.createHash('sha256').update(file.buffer).digest('hex')};
  });
}

// Saves prepared files in the same transaction as their message.
async function save(client,{requestId,messageId=null,accountId=null,files}){
  if(!files?.length)return [];
  const sent=Number((await client.query(`SELECT coalesce(sum(byte_size),0)::bigint n FROM ${TABLE}
    WHERE author_account_id=$1 AND created_at>now()-interval '24 hours'`,[accountId])).rows[0].n);
  if(accountId&&sent+files.reduce((n,f)=>n+f.bytes.length,0)>DAILY_BYTES)
    throw new ValidationError('You have attached a lot of files today. Send this message without them, or try again tomorrow.');
  const saved=[];
  for(const file of files){
    const row=(await client.query(`INSERT INTO ${TABLE}(id,request_id,message_id,author_account_id,file_name,content_type,byte_size,sha256,content)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,message_id,file_name,content_type,byte_size,created_at`,
    [newId('supportfile'),requestId,messageId,accountId,file.name,file.type,file.bytes.length,file.sha256,file.bytes])).rows[0];
    saved.push(shape(row));
  }
  return saved;
}

function shape(row){return {id:row.id,messageId:row.message_id||null,name:row.file_name,type:row.content_type,
  size:Number(row.byte_size),sizeLabel:size(row.byte_size),image:IMAGES.has(row.content_type)};}

// Every file in a conversation, without its contents, keyed by message (null: the first message).
async function forRequest(db,requestId){
  if(!await has(db,TABLE))return new Map();
  const rows=(await db.query(`SELECT id,message_id,file_name,content_type,byte_size,created_at FROM ${TABLE}
    WHERE request_id=$1 ORDER BY created_at,id`,[requestId])).rows;
  const byMessage=new Map();
  for(const row of rows){const key=row.message_id||null;if(!byMessage.has(key))byMessage.set(key,[]);byMessage.get(key).push(shape(row));}
  return byMessage;
}

// One file with its contents. The caller has already checked who may read the conversation.
async function content(db,requestId,id){
  const row=(await db.query(`SELECT id,file_name,content_type,byte_size,content FROM ${TABLE} WHERE request_id=$1 AND id=$2`,[requestId,id])).rows[0];
  if(!row)throw new NotFoundError('That attachment was not found.');
  return row;
}

// Sends one file. Images open in the page; other types download. Nothing in a file can run.
function send(res,row){
  const inline=IMAGES.has(row.content_type),ascii=row.file_name.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_');
  res.set({'Content-Type':row.content_type,'Content-Length':String(row.byte_size),'Cache-Control':'private, max-age=600',
    'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Content-Disposition':`${inline?'inline':'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`});
  return res.end(row.content);
}

// A line for the notification email: names and sizes only, never the files.
function emailLine(files){return files?.length?'\n\nAttached: '+files.map(f=>`${f.name} (${size(f.bytes?.length??f.size)})`).join(', ')+'. Open the conversation to see them.':'';}

module.exports={TABLE,MAX_FILES,MAX_BYTES,MAX_TOTAL,ACCEPT,IMAGES,sniff,cleanName,size,prepare,save,forRequest,content,send,emailLine};
