'use strict';
const {createHash}=require('node:crypto'),path=require('node:path'),{ValidationError,NotFoundError}=require('../domain/errors');
// A bounded, cost-free document preprocessor, never a business decision maker.
// Email and attachment text remain untrusted evidence for the actual agent.
async function extractMessage(database,workspaceId,messageId){
 const message=(await database.query('SELECT id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,messageId])).rows[0];if(!message)throw new NotFoundError('That message is not in this business.');
 const rows=(await database.query('SELECT id,filename,content,content_hash,extracted_text,extraction_status FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id',[workspaceId,messageId])).rows,results=[],deadline=Date.now()+60000;
 for(const row of rows){let text=row.extracted_text,status='READABLE',error=null;
  try{
    if(!['.pdf','.txt'].includes(path.extname(row.filename).toLowerCase()))throw new ValidationError('This attachment format needs a manual document review.');
    if(!Buffer.isBuffer(row.content)||!row.content.length||row.content.length>20*1024*1024)throw new ValidationError('The original attachment is unavailable or too large.');
    if(createHash('sha256').update(row.content).digest('hex')!==row.content_hash)throw new ValidationError('The saved attachment failed its integrity check.');
    if(row.extraction_status!=='READABLE'||!text){if(Date.now()>deadline)throw new ValidationError('This message has more documents than can be read in one bounded review. The remaining originals need review.');text=await require('./document-reader').read({filename:row.filename,buffer:row.content});}
  }catch(e){status='NEEDS_REVIEW';error=e instanceof ValidationError?e.message:'StockChief could not read this attachment completely. Review the original before using its figures.';}
  await database.query(`UPDATE connection_email_attachments SET extracted_text=$4,extraction_status=$5,extraction_error=$6
    WHERE workspace_id=$1 AND message_id=$2 AND id=$3 AND content_hash=$7`,[workspaceId,messageId,row.id,text||null,status,error,row.content_hash]);
  results.push({attachmentId:row.id,status,characters:text?.length||0});
 }
 const review=await require('./postgres-document-review').prepare(database,workspaceId,messageId);
 return {messageId,attachments:results,modelCalls:0,businessEffects:0,review};
}
async function textPage(database,workspaceId,messageId,id,offset=0){
 if(!Number.isSafeInteger(offset)||offset<0)throw new ValidationError('Choose a valid document page.');
 const row=(await database.query(`SELECT id,filename,content_hash,extracted_text,extraction_status,extraction_error FROM connection_email_attachments
   WHERE workspace_id=$1 AND message_id=$2 AND id=$3`,[workspaceId,messageId,id])).rows[0];if(!row)throw new NotFoundError('That attachment is not in this message.');
 const text=row.extracted_text||'';if(offset>text.length)throw new ValidationError('That document page is unavailable.');
 return {id:row.id,filename:row.filename,contentHash:row.content_hash,status:row.extraction_status,error:row.extraction_error,text:text.slice(offset,offset+6000),offset,total:text.length,next:offset+6000<text.length?offset+6000:null,previous:offset?Math.max(0,offset-6000):null};
}
module.exports={extractMessage,textPage};
