'use strict';
// Excel and PDF files for the agent's monthly reports (jobs 161, 162 and 163).
// A report hands over titled tables of finished values; both files show the
// same rows, so what the owner downloads matches the page.

// sheets: [{name, columns:[label], rows:[[value]]}]. Numbers stay numbers.
function workbook(sheets){
  const XLSX=require('xlsx'),book=XLSX.utils.book_new();
  for(const sheet of sheets){
    const ws=XLSX.utils.aoa_to_sheet([sheet.columns,...sheet.rows]);
    ws['!cols']=sheet.columns.map((label,i)=>({wch:Math.min(60,Math.max(12,String(label).length+2,...sheet.rows.slice(0,200).map(r=>String(r[i]??'').length+1)))}));
    XLSX.utils.book_append_sheet(book,ws,String(sheet.name).slice(0,31));
  }
  return XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true});
}

// {title, subtitle, lines:[text], sections:[{heading, columns, rows, note}]}
function pdf({title,subtitle,lines=[],sections=[],footer}){
  const PDF=require('pdfkit'),doc=new PDF({size:'A4',layout:'landscape',margin:36,info:{Title:title,Author:'StockChief'}});
  const font=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const done=new Promise((resolve,reject)=>{const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const width=770,bottom=540;
  doc.font(font).fillColor('#192731');
  doc.fontSize(18).text(title,36,36,{width});
  let y=doc.y+4;
  if(subtitle){doc.fontSize(10).text(subtitle,36,y,{width});y=doc.y+8;}
  for(const line of lines){doc.fontSize(10).text(line,36,y,{width});y=doc.y+4;}
  y+=8;
  for(const section of sections){
    const columns=section.columns,first=Math.min(260,Math.max(140,Math.round(width*0.3)));
    const rest=columns.length>1?Math.floor((width-first)/(columns.length-1)):width;
    const widths=columns.map((_,i)=>i?rest:(columns.length>1?first:width));
    const row=(cells,size=8)=>{
      const height=Math.max(...cells.map((v,i)=>doc.fontSize(size).heightOfString(String(v??''),{width:widths[i]-4})));
      if(y+height>bottom){doc.addPage();y=36;}
      let x=36;cells.forEach((v,i)=>{doc.fontSize(size).text(String(v??''),x,y,{width:widths[i]-4,align:i?'right':'left'});x+=widths[i];});
      y+=height+4;
    };
    if(y+48>bottom){doc.addPage();y=36;}
    doc.fontSize(12).text(section.heading,36,y,{width});y=doc.y+6;
    if(section.rows.length){row(columns,8);for(const r of section.rows)row(r);}
    else{doc.fontSize(9).text(section.empty||'Nothing recorded.',36,y,{width});y=doc.y+4;}
    if(section.note){doc.fontSize(8).text(section.note,36,y,{width});y=doc.y+4;}
    y+=12;
  }
  if(footer){if(y>bottom-20){doc.addPage();y=36;}doc.fontSize(8).text(footer,36,Math.max(y,bottom-10),{width});}
  doc.end();return done;
}

module.exports={workbook,pdf};
