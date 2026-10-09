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
async function pdf(result){
  const PDFDocument=require('pdfkit');
  const fontPath=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const font=require('fontkit').openSync(fontPath);
  const values=[result.config.title,...result.columns,...result.rows.flatMap((row,index)=>
    result.columns.map((column)=>cell(result.displayRows?.[index]?.[column]??row[column])))];
  for(const value of values)for(const character of String(value)){
    const code=character.codePointAt(0);
    if(code<32&&character!=='\n'&&character!=='\r'&&character!=='\t')
      throw new Error('PDF export contains an unsupported control character. Use Excel or CSV.');
    if(code>=32&&!font.hasGlyphForCodePoint(code))
      throw new Error('PDF export cannot safely represent every character in this report. Use Excel or CSV; no text was silently replaced.');
  }
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:result.columns.length>8?'A3':'A4',
      layout:result.columns.length>5?'landscape':'portrait',margin:42,bufferPages:true,
      info:{Title:result.config.title,Author:'StockChief',Subject:'Verified PostgreSQL report'}});
    const chunks=[];doc.on('data',(chunk)=>chunks.push(chunk));doc.on('error',reject);
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    try{
      doc.registerFont('Report',fontPath).font('Report');
      const margin=42,usable=doc.page.width-margin*2,width=usable/result.columns.length;
      const fontSize=result.columns.length>8?7:8;
      const drawHeader=()=>{
        doc.fillColor('#25243b').fontSize(15).text(result.config.title,margin,margin,{width:usable});
        doc.fillColor('#646477').fontSize(8).text(`PostgreSQL source | checked ${result.asOf} | ${result.rows.length} verified rows`,
          margin,doc.y+4,{width:usable});
        doc.y+=15;const top=doc.y;
        doc.fontSize(fontSize);
        const headerHeight=Math.max(23,...result.columns.map((column)=>
          doc.heightOfString(column.replaceAll('_',' '),{width:width-8})+10));
        doc.rect(margin,top,usable,headerHeight).fill('#eceafd');
        doc.fillColor('#302b62').fontSize(fontSize);
        result.columns.forEach((column,index)=>doc.text(column.replaceAll('_',' '),margin+index*width+4,top+5,
          {width:width-8}));
        doc.y=top+headerHeight;return doc.y;
      };
      let y=drawHeader();
      for(const [rowIndex,row] of result.rows.entries()){
        const cells=result.columns.map((column)=>cell(result.displayRows?.[rowIndex]?.[column]??row[column])
          .replaceAll('\r\n','\n').replaceAll('\t','    '));
        doc.fontSize(fontSize);
        const height=Math.max(20,...cells.map((value)=>doc.heightOfString(value,{width:width-8})+8));
        if(height>doc.page.height-margin*2-85)
          throw new Error('One report row is too tall for a legible PDF page. Use Excel or CSV.');
        if(y+height>doc.page.height-margin-20){doc.addPage();y=drawHeader();}
        if(rowIndex%2===1)doc.rect(margin,y,usable,height).fill('#f7f7fb');
        doc.fillColor('#292936').fontSize(fontSize);
        cells.forEach((value,index)=>doc.text(value,margin+index*width+4,y+4,{width:width-8}));
        y+=height;doc.y=y;
      }
      const range=doc.bufferedPageRange();
      for(let index=0;index<range.count;index++){
        doc.switchToPage(index);
        doc.fillColor('#77768a').fontSize(7).text(`StockChief | Page ${index+1} of ${range.count}`,
          margin,doc.page.height-margin-10,{width:doc.page.width-margin*2,height:8,align:'right'});
      }
      doc.end();
    }catch(error){doc.destroy();reject(error);}
  });
}
module.exports={csv,xlsx,pdf};
