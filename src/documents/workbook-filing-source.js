'use strict';

function exactCell(cell){
  return !cell.f&&!cell.c&&['s','str','n'].includes(cell.t)&&typeof cell.v!=='undefined'&&
    !/[\r\n|]/u.test(String(cell.w??cell.v));
}

async function read(buffer,ext){
  const xlsx=require('xlsx');
  let hasEmbedded=ext==='.xls';
  if(ext==='.xlsx'){
    const zip=await require('jszip').loadAsync(buffer);
    if(!zip.files['xl/workbook.xml'])throw Error('This Excel original does not contain a complete workbook.');
    hasEmbedded=Object.keys(zip.files).some(name=>/^xl\/(?:drawings|embeddings|externalLinks|media)\//u.test(name));
  }else if(!buffer.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'))){
    throw Error('This Excel original is not an intact legacy workbook.');
  }
  const book=xlsx.read(buffer,{type:'buffer',cellText:true,cellFormula:true,cellStyles:true,cellHTML:false});
  if(!book.SheetNames.length||book.SheetNames.length>100)throw Error('Use a complete workbook with up to 100 readable sheets.');
  let cells=0,characters=0;
  return book.SheetNames.map((name,n)=>{
    const sheet=book.Sheets[name],rows=new Map();
    for(const address of Object.keys(sheet)){
      if(address.startsWith('!'))continue;
      if(++cells>200000)throw Error('This complete workbook exceeds the safe reading limit.');
      const cell=sheet[address],value=String(cell.w??cell.v??'');
      if(!value&&!cell.f&&!cell.c)continue;
      const pos=xlsx.utils.decode_cell(address),row=rows.get(pos.r)||[];
      row.push({col:pos.c,value,cell,address});
      rows.set(pos.r,row);
    }
    const text=[],proof=[];let uncertainReference=false;
    for(const [rowNumber,entries] of [...rows].sort(([a],[b])=>a-b)){
      entries.sort((a,b)=>a.col-b.col);
      const printable=entries.map(({value,cell,address})=>{
        const annotation=cell.c?.map(note=>note.t||'').filter(Boolean).join(' · ');
        return address+' '+value+(cell.f?' [Formula: '+cell.f+']':'')+(annotation?' [Cell note: '+annotation+']':'');
      }).join(' | ');
      characters+=printable.length+1;
      if(characters>2000000)throw Error('This complete workbook exceeds the safe reading limit.');
      text.push(printable);
      if(entries.length<=2&&entries.every(({cell,col})=>exactCell(cell)&&!sheet['!cols']?.[col]?.hidden)&&
        !sheet['!rows']?.[rowNumber]?.hidden&&
        (entries.length===1||entries[1].col===entries[0].col+1))proof.push(entries.map(e=>e.value).join(' | '));
      else{
        if(entries.some(({value})=>require('./document-target-proof').mightIdentify(value.trim())))uncertainReference=true;
        proof.push('[Worksheet row requires original cell context]');
      }
    }
    const hidden=Boolean(book.Workbook?.Sheets?.[n]?.Hidden||sheet['!rows']?.some(row=>row?.hidden)||sheet['!cols']?.some(col=>col?.hidden));
    const annotation=Object.values(sheet).some(cell=>Array.isArray(cell?.c)&&cell.c.length);
    return {page:n+1,sourceName:name,text:text.join('\n'),proofText:proof.join('\n'),
      requiresSourceConfirmation:hasEmbedded||hidden||annotation||uncertainReference};
  });
}
module.exports={read};
