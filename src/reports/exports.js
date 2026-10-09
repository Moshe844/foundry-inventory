'use strict';

const zlib=require('node:zlib');

function cell(value){return value==null?'':String(value);}
function csv(result){
  // Spreadsheet apps can execute formulas even inside a quoted CSV field.
  // Preserve the recorded text while forcing dangerous leading characters to
  // remain text when a customer opens the export in Excel or Sheets.
  const quote=(value)=>{let text=cell(value);
    if(/^[\s\u0000-\u001f]*[=+\-@]/u.test(text))text=`'${text}`;
    return `"${text.replaceAll('"','""')}"`;};
  return Buffer.from([result.columns.map(quote).join(','),...result.rows.map((row)=>
    result.columns.map((column)=>quote(row[column])).join(','))].join('\r\n')+'\r\n','utf8');
}
function xml(value){return cell(value).replace(/[&<>"']/g,(character)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));}
function crc32(buffer){let crc=~0;for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit++)
  crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (~crc)>>>0;}
function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,content] of Object.entries(files)){
    const filename=Buffer.from(name),original=Buffer.from(content),compressed=zlib.deflateRawSync(original),
      crc=crc32(original),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);
    header.writeUInt32LE(original.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,compressed);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);
    directory.writeUInt16LE(20,6);directory.writeUInt16LE(8,10);
    directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);
    directory.writeUInt32LE(original.length,24);directory.writeUInt16LE(filename.length,28);
    directory.writeUInt32LE(offset,42);central.push(directory,filename);
    offset+=header.length+filename.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);
  end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);
  end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
function xlsx(result){
  const rows=[result.columns,...result.rows.map((row)=>result.columns.map((column)=>row[column]))];
  const worksheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row,index)=>
      `<row r="${index+1}">${row.map((value,column)=>{
        const numeric=index>0&&value!==null&&value!==''&&typeof value==='number'&&Number.isFinite(value);
        const address=`${String.fromCharCode(65+column)}${index+1}`;
        return numeric?`<c r="${address}"><v>${value}</v></c>`:
          `<c r="${address}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
      }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zip({'[Content_Types].xml':`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>
    <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`,
  '_rels/.rels':`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
  'xl/workbook.xml':`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`,
  'xl/worksheets/sheet1.xml':worksheet});
}
function pdf(result){
  // A compact text-first PDF. It carries only displayed, verified result rows;
  // exports with more than 5,000 rows are refused before reaching this module.
  if([result.config.title,...result.columns,...result.rows.flatMap((row)=>
    result.columns.map((column)=>cell(row[column])))].some((value)=>/[^\x20-\x7e]/u.test(value)))
    throw new Error('PDF export cannot safely represent every character in this report. Use Excel or CSV; no text was silently replaced.');
  const lines=[result.config.title,`Source: PostgreSQL - ${result.asOf}`,
    result.columns.join(' | '),...result.rows.map((row)=>result.columns.map((column)=>cell(row[column])).join(' | '))]
    .flatMap((line)=>line.match(/.{1,110}/g)||['']);
  const pages=[];for(let index=0;index<lines.length;index+=48)pages.push(lines.slice(index,index+48));
  const objects=[];const add=(body)=>{objects.push(body);return objects.length;};
  const catalog=add(''),pageTree=add(''),font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds=[];
  for(const pageLines of pages){
    const content=['BT /F1 9 Tf 44 790 Td 12 TL'];
    for(const line of pageLines){
      const printable=line.replace(/[\\()]/g,'\\$&');
      content.push(`(${printable}) Tj T*`);
    }
    content.push('ET');const stream=content.join('\n'),bytes=Buffer.byteLength(stream);
    const streamId=add(`<< /Length ${bytes} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 842]
      /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${streamId} 0 R >>`));
  }
  objects[catalog-1]=`<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree-1]=`<< /Type /Pages /Kids [${pageIds.map((id)=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let document='%PDF-1.4\n';const offsets=[0];
  for(let index=0;index<objects.length;index++){
    offsets.push(Buffer.byteLength(document));document+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref=Buffer.byteLength(document);
  document+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))document+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  document+=`trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document,'ascii');
}
module.exports={csv,xlsx,pdf};
