'use strict';

const zlib=require('node:zlib');

function cell(value){return value==null?'':String(value);}
// The on-screen values are the governed, currency-aware representation of the
// same verified rows. Exporting the raw minor-unit integers as unlabeled
// spreadsheet numbers would make $17.40 look like 1740.
function exportValue(result,rowIndex,column){
  const raw=result.rows[rowIndex][column];if(result.columnTypes?.[column]==='money_minor'&&raw!=null){const currency=result.rows[rowIndex].currency||result.provenance?.currency;if(currency)return require('../domain/currency').fromMinor(raw,currency);}return result.columnTypes?.[column]==='number'?raw:result.displayRows?.[rowIndex]?.[column]??raw;
}
// Spreadsheet apps can execute formulas even inside quoted CSV fields.
// Preserve the recorded text while forcing dangerous leading characters to
// remain text when a customer opens the export in Excel or Sheets.
function csvCell(value,{numeric=false}={}){let text=cell(value);if(numeric&&/^-?\d+(?:\.\d+)?$/.test(text))return text;
  if(/^[\s\u0000-\u001f]*[=+\-@]/u.test(text))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;}
// Excel reads a CSV as the computer's old code page unless it starts with the
// UTF-8 mark, which turns a dash or an accented name into garbage.
const UTF8_MARK=String.fromCharCode(0xfeff);
function csvHeader(result){return `${UTF8_MARK}${result.columns.map((column)=>csvCell(result.columnLabels?.[column]||column)).join(',')}\r\n`;}
function csvRows(result){return result.rows.map((_row,index)=>
  `${result.columns.map((column)=>csvCell(exportValue(result,index,column),{numeric:['number','money_minor'].includes(result.columnTypes?.[column])})).join(',')}\r\n`).join('');}
function csv(result){return Buffer.from(csvHeader(result)+csvRows(result),'utf8');}
// XML 1.0 cannot hold most control characters or unpaired surrogates, and
// Excel refuses a whole file that contains one, so they are left out.
const NOT_XML=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function xml(value){return cell(value).replace(NOT_XML,'').replace(/[&<>"']/g,(character)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));}
function crc32(buffer){let crc=~0;for(const byte of buffer){crc^=byte;for(let bit=0;bit<8;bit++)
  crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (~crc)>>>0;}
// Each entry is dated 1 January 1980, the first valid date a zip can hold.
const DOS_DATE=(0<<9)|(1<<5)|1;
function zip(files){
  const local=[],central=[];let offset=0;
  for(const [name,content] of Object.entries(files)){
    const filename=Buffer.from(name),original=Buffer.from(content),compressed=zlib.deflateRawSync(original),
      crc=crc32(original),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt16LE(DOS_DATE,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);
    header.writeUInt32LE(original.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,compressed);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);
    directory.writeUInt16LE(20,6);directory.writeUInt16LE(8,10);directory.writeUInt16LE(DOS_DATE,14);
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
// A column with no declared type holds figures saved as text ("4", "12.5"):
// they go in as numbers so Excel can add them up. Codes with a leading zero and
// long digit runs such as barcodes stay text, so Excel cannot rewrite them.
const PLAIN_NUMBER=/^-?(?:0|[1-9]\d{0,8})(?:\.\d+)?$/;
// Spreadsheet column names: A..Z, then AA, AB, and on.
function columnName(index){let name='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name;}
// Excel checks every part against its declared type and refuses the file when
// one is wrong, so the workbook part names its own type, not the file type.
function worksheetXml(result){
  const rows=[result.columns.map((column)=>result.columnLabels?.[column]||column),
    ...result.rows.map((_row,index)=>result.columns.map((column)=>
    exportValue(result,index,column)))];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row,index)=>
      `<row r="${index+1}">${row.map((value,column)=>{
        const type=result.columnTypes?.[result.columns[column]];
        const numeric=index>0&&value!==null&&value!==''&&(typeof value==='number'&&Number.isFinite(value)||['number','money_minor'].includes(type)&&/^-?\d+(?:\.\d+)?$/.test(String(value))||!type&&PLAIN_NUMBER.test(String(value)));
        const address=`${columnName(column)}${index+1}`;
        return numeric?`<c r="${address}"><v>${value}</v></c>`:
          `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xml(cell(value).slice(0,32767))}</t></is></c>`;
      }).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
// Excel sheet names: at most 31 characters, none of []:*?/\, and unique.
function sheetNames(sheets){
  const used=new Set();
  return sheets.map((sheet,index)=>{
    const base=String(sheet.name||'Report').replace(/[[\]:*?/\\]/g,' ').trim().slice(0,31)||'Sheet '+(index+1);
    let name=base;for(let n=2;used.has(name.toLowerCase());n++)name=base.slice(0,31-String(n).length-1)+' '+n;
    used.add(name.toLowerCase());return name;
  });
}
// One report is one "Report" sheet. A result with `sheets` holds several
// reports, each on its own sheet in the same workbook.
function xlsx(result){
  const sheets=Array.isArray(result.sheets)?result.sheets:[{...result,name:'Report'}],names=sheetNames(sheets);
  const files={'[Content_Types].xml':`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
    ${sheets.map((_sheet,index)=>`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n    ')}
    </Types>`,
  '_rels/.rels':`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`,
  'xl/workbook.xml':`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>${names.map((name,index)=>`<sheet name="${xml(name)}" sheetId="${index+1}" r:id="rId${index+1}"/>`).join('')}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${sheets.map((_sheet,index)=>`<Relationship Id="rId${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join('\n    ')}
    </Relationships>`};
  sheets.forEach((sheet,index)=>{files[`xl/worksheets/sheet${index+1}.xml`]=worksheetXml(sheet);});
  return zip(files);
}
async function pdf(result){
  const PDFDocument=require('pdfkit');
  const fontPath=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const font=require('fontkit').openSync(fontPath);
  // A result with `sheets` prints each one as its own section, from a new page.
  const sections=Array.isArray(result.sheets)?result.sheets.map((sheet)=>({...sheet,
    config:{title:`${result.config.title} · ${sheet.title||sheet.name}`}})):[result];
  const values=sections.flatMap((section)=>[section.config.title,section.sourceLabel||'',...section.columns.map((column)=>section.columnLabels?.[column]||column),
    ...section.rows.flatMap((row,index)=>
    section.columns.map((column)=>cell(section.displayRows?.[index]?.[column]??row[column])))]);
  for(const value of values)for(const character of String(value)){
    const code=character.codePointAt(0);
    if(code<32&&character!=='\n'&&character!=='\r'&&character!=='\t')
      throw new Error('PDF export contains an unsupported control character. Use Excel or CSV.');
    if(code>=32&&!font.hasGlyphForCodePoint(code)){
      const error=new Error('PDF export cannot safely represent every character in this report. Use Excel or CSV; no text was silently replaced.');
      error.code='report_pdf_missing_glyph';
      throw error;
    }
  }
  const widest=Math.max(...sections.map((section)=>section.columns.length));
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:widest>8?'A3':'A4',
      layout:widest>5?'landscape':'portrait',margin:42,bufferPages:true,
      info:{Title:result.config.title,Author:'StockChief',Subject:'Verified PostgreSQL report'}});
    const chunks=[];doc.on('data',(chunk)=>chunks.push(chunk));doc.on('error',reject);
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    try{
      doc.registerFont('Report',fontPath).font('Report');
      for(const [sectionIndex,result] of sections.entries()){
        if(sectionIndex>0)doc.addPage();
        const margin=42,usable=doc.page.width-margin*2,width=usable/result.columns.length;
        const fontSize=result.columns.length>8?7:8;
        const drawHeader=()=>{
          doc.fillColor('#25243b').fontSize(15).text(result.config.title,margin,margin,{width:usable});
          doc.fillColor('#646477').fontSize(8).text(result.sourceLabel||`PostgreSQL source | checked ${result.asOf} | ${result.rows.length} verified rows`,
            margin,doc.y+4,{width:usable});
          doc.y+=15;const top=doc.y;
          doc.fontSize(fontSize);
          const headerHeight=Math.max(23,...result.columns.map((column)=>
            doc.heightOfString((result.columnLabels?.[column]||column).replaceAll('_',' '),{width:width-8})+10));
          doc.rect(margin,top,usable,headerHeight).fill('#eceafd');
          doc.fillColor('#302b62').fontSize(fontSize);
          result.columns.forEach((column,index)=>doc.text((result.columnLabels?.[column]||column).replaceAll('_',' '),margin+index*width+4,top+5,
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
      }
      const margin=42;
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
module.exports={csv,csvHeader,csvRows,xlsx,pdf};
