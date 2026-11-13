'use strict';
// Any table Ask showed can be saved. The figures are the ones on screen, in the same
// words, so the file a person downloads cannot disagree with the answer they read.
const reportExports=require('../reports/exports');
const {ValidationError,NotFoundError}=require('../domain/errors');
const TYPES=Object.freeze({csv:'text/csv; charset=utf-8',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'});
const plain=text=>String(text).replace(/\*\*/g,'').trim();
const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(plain);
const divider=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
// The pipe tables inside a written answer, each with the heading above it.
function tables(answer){
 const lines=String(answer||'').split(/\r?\n/),found=[];let heading=null;
 for(let i=0;i<lines.length;i++){
  if(/^#{1,4}\s/.test(lines[i]))heading=plain(lines[i].replace(/^#+\s*/,''));
  if(!lines[i].includes('|')||!divider(lines[i+1]||''))continue;
  const columns=cells(lines[i]),rows=[];let next=i+2;
  for(;next<lines.length&&lines[next].includes('|');next++)rows.push(cells(lines[next]));
  if(rows.length)found.push({title:heading,columns,rows});
  i=next-1;
 }
 return found;
}
function shape({title,columns,labels,rows}){
 const objects=rows.map(row=>Object.fromEntries(columns.map((column,index)=>[column,Array.isArray(row)?row[index]??'':row[column]??''])));
 return {config:{title},columns,columnLabels:labels,rows:objects,displayRows:objects,asOf:new Date().toISOString().slice(0,10)};
}
function fromTable(table,fallbackTitle){
 const columns=table.columns.map((_,index)=>'column_'+index);
 return shape({title:table.title||fallbackTitle,columns,labels:Object.fromEntries(columns.map((column,index)=>[column,table.columns[index]])),rows:table.rows});
}
const fileName=title=>(String(title||'stockchief-answer').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'stockchief-answer');
async function send(res,format,result){
 if(!Object.hasOwn(TYPES,format))throw new ValidationError('That download format is unavailable.');
 if(!result.rows.length)throw new NotFoundError('That answer has no table to download.');
 let output;
 try{output=await reportExports[format](result);}
 catch(error){if(/PDF export/.test(String(error.message)))throw new ValidationError(error.message);throw error;}
 res.set('Content-Type',TYPES[format]);
 res.set('Content-Disposition',`attachment; filename="${fileName(result.config.title)}.${format}"`);
 res.set('Cache-Control','private, no-store');
 return res.send(output);
}
// Several tables in one answer share one sheet: each after the first starts
// with a blank row, its heading and its own column names.
function stacked(found,fallbackTitle){
 const width=Math.max(...found.map(table=>table.columns.length)),columns=Array.from({length:width},(_,index)=>'column_'+index);
 const pad=row=>Array.from({length:width},(_,index)=>row[index]??'');
 const rows=found.flatMap((table,index)=>[...(index?[pad([]),...(table.title?[pad([table.title])]:[]),pad(table.columns)]:[]),...table.rows.map(pad)]);
 return shape({title:found[0].title||fallbackTitle,columns,labels:Object.fromEntries(columns.map((column,index)=>[column,found[0].columns[index]??''])),rows});
}
// Long lines break between words, so no word is cut across two rows.
function wrap(line,size=240){
 const parts=[];let rest=line;
 while(rest.length>size){const high=rest.charCodeAt(size-1),head=rest.slice(0,high>=0xd800&&high<=0xdbff?size-1:size),space=head.lastIndexOf(' '),take=space>size/2?head.slice(0,space):head;parts.push(take);rest=rest.slice(take.length).replace(/^ /,'');}
 parts.push(rest);return parts;
}
function written(answer){
 if(typeof answer!=='string'||!answer.trim())throw new NotFoundError('This answer has no saved text to download.');
 // Split long responses so one spreadsheet cell or PDF table row cannot truncate the answer.
 const lines=answer.split(/\r?\n/).flatMap(line=>wrap(line));
 return {...shape({title:'StockChief answer',columns:['answer'],labels:{answer:'Answer'},rows:lines.map(line=>[line])}),sourceLabel:'Saved StockChief answer'};
}
// A spreadsheet of an answer holds its figures in columns, one per field; the
// written words belong in the PDF. An answer with no table downloads as its text.
const SHEET=new Set(['csv','xlsx']);
async function interaction(database,ctx,id,columnLabel,fullAnswer=false,format){
 const row=(await database.query('SELECT message,answer,evidence,intent FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,id])).rows[0];
 if(!row)throw new NotFoundError('That answer is not in your saved work.');
 const rows=row.evidence||[],presentation=row.intent?.presentation||{},columns=(presentation.columns?.length?presentation.columns:Object.keys(rows[0]||{})).filter(column=>column!=='href');
 if((fullAnswer&&!SHEET.has(format))||!rows.length){
  const inText=fullAnswer&&SHEET.has(format)?tables(row.answer):[];
  if(inText.length)return inText.length===1?fromTable(inText[0],row.message):stacked(inText,row.message);
  return written(row.answer);
 }
 return shape({title:row.message,columns,labels:Object.fromEntries(columns.map(column=>[column,presentation.columnLabels?.[column]||columnLabel(column)||column])),rows:rows.map(item=>Object.fromEntries(columns.map(column=>[column,item[column]===null||item[column]===undefined?'':item[column]])))});
}
function goal(found,index,fullAnswer=false,format){
 if(fullAnswer){
  const inText=SHEET.has(format)?tables(found?.answer):[];
  if(!inText.length)return written(found?.answer);
  return inText.length===1?fromTable(inText[0],found.original_request):stacked(inText,found.original_request);
 }
 const available=tables(found?.answer);
 if(!available.length&&index===undefined)return written(found?.answer);
 const table=available[Number(index)||0];
 if(!table)throw new NotFoundError('That answer has no table to download.');
 return fromTable(table,found.original_request);
}
// Job 160: a document the agent wrote for an answer (a draft, a plan, a list)
// downloads like any answer: its tables in columns for a spreadsheet, its
// words in a PDF.
function work(product,format){
 if(!product||typeof product.content!=='string')throw new NotFoundError('That work product is not available.');
 const title=String(product.title||'StockChief work').slice(0,120),inText=SHEET.has(format)?tables(product.content):[];
 if(inText.length)return inText.length===1?fromTable(inText[0],title):stacked(inText,title);
 const text=written(product.content);return {...text,config:{title},sourceLabel:title};
}
// A whole conversation: each question and answer in order, long answers split
// between words so no cell or PDF row cuts one short.
function conversation(turns,publicText=text=>text){
 if(!Array.isArray(turns)||!turns.length)throw new NotFoundError('That conversation has nothing to download.');
 const lines=(who,text)=>String(text).split(/\r?\n/).flatMap(line=>wrap(line)).map((line,index)=>[index?'':who,line]);
 const rows=turns.flatMap(turn=>[...lines('You',turn.message||''),...lines('StockChief',publicText(turn.answer||'(no answer recorded)'))]);
 return {...shape({title:'StockChief conversation',columns:['who','said'],labels:{who:'Who',said:'Said'},rows}),sourceLabel:'StockChief conversation'};
}
// A download is offered only for an answer worth keeping: one with records, a
// table, or a written report. "Opening Purchasing." is not a document.
// ask-tools.js applies the same length to answers written in the page.
const LONG_ANSWER=400;
function worthKeeping(answer,rowCount=0){
 return Number(rowCount)>0||tables(answer).length>0||String(answer||'').trim().length>=LONG_ANSWER;
}
// Which of these saved answers (one query for the whole page) are worth keeping.
async function keepable(database,ctx,ids){
 const wanted=[...new Set(ids.filter(id=>typeof id==='string'))];
 if(!wanted.length)return [];
 const rows=(await database.query(`SELECT id,answer,CASE WHEN jsonb_typeof(evidence)='array' THEN jsonb_array_length(evidence) ELSE 0 END AS row_count
   FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 AND actor_user_id=$2 AND id=ANY($3::text[])`,[ctx.workspaceId,ctx.actorId,wanted])).rows;
 return rows.filter(row=>worthKeeping(row.answer,row.row_count)).map(row=>row.id);
}
module.exports={TYPES,LONG_ANSWER,tables,send,interaction,goal,work,conversation,worthKeeping,keepable};
