'use strict';

const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');

const fields={
  sku:['sku','sku code','item code','product code','stock code','code','variant sku'],
  location:['location','warehouse','bin','shelf','count location','counted at'],
  quantity:['counted quantity','physical quantity','quantity','actual count','count','qty','on hand count'],
  unit:['stocking unit','unit','uom','counting unit','unit label'],
  lot:['lot','lot code','lot number','batch','batch code','batch number'],
  serial:['serial','serial number','serial no','serial code'],
  secondary:['actual weight','counted weight','weight','secondary quantity','independent measure','measured quantity'],
  secondaryUnit:['weight unit','secondary unit','measure unit','independent unit'],
  cost:['unit cost','purchase cost','count cost','cost'],
  currency:['currency','cost currency'],
};
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().trim().replace(/[\s_-]+/g,' ');
const fieldNames=Object.keys(fields);

function mapping(columns){
  const names=columns.map(c=>normalize(c.name)),result={};
  for(const [field,aliases] of Object.entries(fields)){
    const matches=names.map((name,index)=>aliases.includes(name)?index:-1).filter(index=>index>=0);
    if(matches.length>1)throw new ValidationError('More than one column could mean '+field+'. Use one explicit count heading for each field.');
    if(matches.length)result[field]=matches[0];
  }
  return result;
}

async function shelfTags(buffer){
  const {createWorker,PSM}=require('tesseract.js'),english=require('@tesseract.js-data/eng');
  const worker=await createWorker(english.code,1,{langPath:english.langPath,gzip:english.gzip,cacheMethod:'readOnly'});
  const rows=[];
  try{
    await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK});
    for await(const page of require('./handwritten-table').pages(buffer)){
      const image=Buffer.from(page.block.source.data,'base64');
      const text=(await worker.recognize(image)).data.text;
      let values={},evidence=[],firstLine=1;
      function retain(){
        if(!evidence.length)return;
        rows.push({number:rows.length+1,raw:{sheet:'Shelf photo '+page.page,row:firstLine,headings:evidence.map(entry=>entry[0]),
          cells:evidence.map(entry=>entry[1]),observations:[]},observed:Object.fromEntries(fieldNames.map(key=>[key,values[key]||''])),checked:false});
        values={};evidence=[];
      }
      for(const [index,line] of text.split(/\r?\n/).entries()){
        const parts=/^\s*([^:=]+)\s*[:=]\s*(.*?)\s*$/.exec(line);
        if(!parts)continue;
        const field=Object.keys(fields).find(key=>fields[key].includes(normalize(parts[1])));
        if(!field)continue;
        if(field==='sku'&&Object.hasOwn(values,field))retain();
        if(!evidence.length)firstLine=index+1;
        evidence.push([parts[1],parts[2]]);
        values[field]=Object.hasOwn(values,field)?'':parts[2];
      }
      retain();
    }
  }finally{await worker.terminate();}
  if(!rows.some(row=>row.observed.sku&&row.observed.quantity))
    throw new ValidationError('Read the shelf photo with a clear SKU and physical count tag. Visible boxes with unknown contents need review.');
  const layoutHash=hash([...new Set(rows.map(row=>JSON.stringify(row.raw.headings.map(normalize))))].sort());
  return {visual:true,rows,layoutHash};
}

async function parse(buffer,filename){
  const image=require('./image-table'),pdf=buffer.subarray(0,5).toString()==='%PDF-';
  const photo=image.isImage(buffer);
  let raw;
  try{raw=pdf?await require('./pdf-table').parse(buffer):photo?await image.parse(buffer):require('./parser').parse({buffer,filename});}
  catch(error){if(photo&&error instanceof ValidationError)return shelfTags(buffer);throw error;}
  const visual=pdf||photo||raw.format==='image'||raw.format==='pdf';
  const rows=[],layout=[];
  for(const [sheetIndex,sheet] of raw.sheets.entries()){
    if(!sheet.rows.length)continue;
    const headings=sheet.columns.map(column=>column.name);
    let mapped={},note=null;
    try{
      mapped=mapping(sheet.columns);
      if(mapped.sku==null||mapped.quantity==null)note='Identify the exact SKU and physical quantity in this source.';
    }catch(error){
      if(!(error instanceof ValidationError))throw error;
      note=error.message;
    }
    layout.push([sheetIndex,Object.entries(mapped).sort(),headings.map(normalize)]);
    for(const row of sheet.rows){
      const entries=Object.fromEntries(fieldNames.map(field=>[field,String(row.cells[mapped[field]]??'').trim()]));
      rows.push({number:rows.length+1,raw:{sheet:sheet.name,sheetIndex,row:row.sourceRow,headings,cells:row.originalCells||row.cells,
        observations:row.problems||[]},observed:entries,checked:!visual&&!note&&!row.problems?.length,
        issue:note||row.problems?.map(p=>p.message).filter(Boolean).join(' ')||null});
    }
  }
  if(photo&&!rows.some(row=>row.observed.sku&&row.observed.quantity))return shelfTags(buffer);
  if(!rows.length)throw new ValidationError('No physical count rows could be read. Review the saved original and upload a readable count.');
  return {visual,rows,layoutHash:hash(layout)};
}

module.exports={parse,fieldNames,fields};
