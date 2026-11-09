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
function written(answer){
 if(typeof answer!=='string'||!answer.trim())throw new NotFoundError('This answer has no saved text to download.');
 // Split long responses so one spreadsheet cell or PDF table row cannot truncate the answer.
 const lines=answer.split(/\r?\n/).flatMap(line=>line.match(/[\s\S]{1,240}/gu)||['']);
 return {...shape({title:'StockChief answer',columns:['answer'],labels:{answer:'Answer'},rows:lines.map(line=>[line])}),sourceLabel:'Saved StockChief answer'};
}
async function interaction(database,ctx,id,columnLabel,fullAnswer=false){
 const row=(await database.query('SELECT message,answer,evidence,intent FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,id])).rows[0];
 if(!row)throw new NotFoundError('That answer is not in your saved work.');
 const rows=row.evidence||[],presentation=row.intent?.presentation||{},columns=(presentation.columns?.length?presentation.columns:Object.keys(rows[0]||{})).filter(column=>column!=='href');
 if(fullAnswer||!rows.length)return written(row.answer);
 return shape({title:row.message,columns,labels:Object.fromEntries(columns.map(column=>[column,presentation.columnLabels?.[column]||columnLabel(column)||column])),rows:rows.map(item=>Object.fromEntries(columns.map(column=>[column,item[column]===null||item[column]===undefined?'':item[column]])))});
}
function goal(found,index,fullAnswer=false){
 if(fullAnswer)return written(found?.answer);
 const available=tables(found?.answer);
 if(!available.length&&index===undefined)return written(found?.answer);
 const table=available[Number(index)||0];
 if(!table)throw new NotFoundError('That answer has no table to download.');
 return fromTable(table,found.original_request);
}
module.exports={TYPES,tables,send,interaction,goal};
