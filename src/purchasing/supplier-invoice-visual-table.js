'use strict';
// Restore physical table columns from the reader's original OCR word boxes.
// Every observed word is retained. No product, identifier, number or letter is
// guessed from the PO, and ambiguous layouts still need owner confirmation.
function text(page,{columns=require('./supplier-invoice-source-parser').columns}={}){if(!page.ocrWords?.length)return null;const lines=[];
 for(const word of page.ocrWords){const y=(word.y0+word.y1)/2,height=Math.max(1,word.y1-word.y0);let line=lines.find(l=>Math.abs(l.y-y)<Math.min(l.height,height)*.65);if(!line){line={y,height,words:[]};lines.push(line);}line.words.push(word);}
 lines.sort((a,b)=>a.y-b.y);let table=null,found=false;const output=[];
 for(const line of lines){const words=line.words.sort((a,b)=>a.x0-b.x0),cells=[];for(const w of words){const prior=cells.at(-1);if(prior&&w.x0-prior.right<line.height*.8){prior.text+=' '+w.text;prior.right=w.x1;}else cells.push({text:w.text,x:w.x0,right:w.x1});}
  if(columns(cells.map(c=>c.text))){table={cells,boundaries:cells.slice(1).map((c,i)=>(cells[i].right+c.x)/2)};found=true;output.push(cells.map(c=>c.text).join('|'));continue;}
  if(table){const joined=words.map(w=>w.text).join(' ');if(!/\d/.test(joined)){output.push(joined);continue;}if(/^(?:subtotal|sub total|tax|vat|gst|total|grand total|amount due|freight|shipping|insurance|duty|discount|terms|payment terms|due date|invoice total|page)\b/i.test(joined)){table=null;output.push(joined);continue;}const values=Array(table.cells.length).fill('');for(const w of words){let i=0;while(i<table.boundaries.length&&w.x0>=table.boundaries[i])i++;values[i]+=(values[i]?' ':'')+w.text;}output.push(values.join('|'));}
  else output.push(words.map(w=>w.text).join(' '));
 }
 return found?output.join('\n'):null;
}
module.exports={text};
