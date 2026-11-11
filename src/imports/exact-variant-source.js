'use strict';

const {ValidationError}=require('../domain/errors');
const parser=require('./parser');
const supported=/\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|txt)$/iu;
const columns={
  parent:/^(?:parent|product|style|model|family|article)(?:[ -]+(?:code|id|sku|number|no\.?))$|^(?:(?:url|product) )?handle$|^parent$/iu,
  name:/^(?:product(?: name| title)?|name|title|item name|style name|model name|product title)$/iu,
  sku:/^(?:variant[ -]+sku|variant[ -]+code|sku(?:[ -]+code)?|stock[ -]+code|item[ -]+sku)$/iu,
  barcode:/^(?:variant[ -]+)?(?:barcodes?|gtin|upc|ean)(?:[ -]+\d+)?$/iu
};
const explicitAxis=/^(?:option|attribute|variation)[ :_-]+(.+)$/iu;
const knownAxis=/^(?:sizes?|colou?rs?|style|finish|material|scent|flavou?r|width|length|height|fit|pattern|capacity|pack(?: size)?|voltage|edition|shade)$/iu;
const wideSku=/^(?:size[ :_-]+)?(.+?)[ :_-]+sku$/iu;
const normalized=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const value=(row,index)=>index===null||index===undefined?'':String(row.cells[index]??'').trim();

function validText(text,max){
  return Boolean(text)&&text.length<=max&&!/[\x00-\x1f\x7f]/u.test(text);
}

function automaticMapping(sheet){
  const candidates=Object.fromEntries(Object.entries(columns).map(([field,pattern])=>[field,sheet.columns.filter(c=>pattern.test(c.name.trim()))]));
  const fields=Object.fromEntries(Object.entries(candidates).map(([field,matches])=>[field,matches.length===1?matches[0].index:null]));
  const warnings=Object.entries(candidates).filter(([,matches])=>matches.length>1).map(([field])=>'Choose which '+field+' column to use.');
  const axes=[],pairs=[],matrix=[];
  for(const col of sheet.columns){
    if(Object.values(fields).includes(col.index))continue;
    const label=col.name.trim();
    const paired=/^option\s*(\d+)\s*(name|value)$/iu.exec(label);
    if(paired&&paired[2].toLowerCase()==='value'){
      const name=sheet.columns.find(c=>normalized(c.name).replace(/\s+/gu,'')==='option'+paired[1]+'name');
      if(name)pairs.push({index:col.index,nameIndex:name.index});
      else warnings.push('Choose the option name for '+label+'.');
      continue;
    }
    const wide=/^size[ :_-]/iu.test(label)&&wideSku.exec(label);
    if(wide){matrix.push({index:col.index,label:wide[1]});continue;}
    const explicit=explicitAxis.exec(label);
    if(explicit||knownAxis.test(label))axes.push({index:col.index,label:explicit?.[1]||label.replace(/^sizes$/iu,'Size').replace(/^colou?rs$/iu,'Color')});
  }
  const variantShape=fields.sku!==null&&(axes.length||pairs.length)||matrix.length;
  const mode=variantShape?'variants':fields.parent!==null&&fields.name!==null&&fields.sku===null&&!axes.length&&!pairs.length?'products':'unmapped';
  return {mode,...fields,axes,pairs,matrix,matrixName:'Size',fillParent:false,warnings};
}

function checkedMapping(sheet,input){
  const automatic=automaticMapping(sheet);
  if(!input)return automatic;
  const index=raw=>{
    if(raw===null||raw===undefined||raw==='')return null;
    const n=Number(raw);
    if(!Number.isSafeInteger(n)||!sheet.columns.some(c=>c.index===n))throw new ValidationError('Choose a column from this exact worksheet.');
    return n;
  };
  if(!['variants','products','skip'].includes(input.mode))throw new ValidationError('Choose how to use each worksheet.');
  const out={mode:input.mode,parent:index(input.parent),name:index(input.name),sku:index(input.sku),barcode:index(input.barcode),
    axes:[],pairs:[],matrix:[],matrixName:String(input.matrixName||'Size').trim(),fillParent:input.fillParent===true,warnings:[]};
  const list=raw=>Array.isArray(raw)?raw:[];
  for(const a of list(input.axes)){
    const col=index(a.index),label=String(a.label||sheet.columns.find(c=>c.index===col)?.name||'').trim();
    if(col===null||!validText(label,120))throw new ValidationError('Use the worksheet’s exact option column and a readable option name.');
    out.axes.push({index:col,label});
  }
  for(const a of list(input.pairs)){
    const col=index(a.index),name=index(a.nameIndex);
    if(col===null||name===null)throw new ValidationError('Choose both columns for a paired option name and value.');
    out.pairs.push({index:col,nameIndex:name});
  }
  for(const a of list(input.matrix)){
    const col=index(a.index),label=String(a.label||sheet.columns.find(c=>c.index===col)?.name||'').trim();
    if(col===null||!validText(label,120)||!validText(out.matrixName,120))throw new ValidationError('Choose exact SKU cells and their option labels.');
    out.matrix.push({index:col,label});
  }
  const selected=[out.parent,out.name,out.sku,out.barcode,...out.axes.map(a=>a.index),...out.pairs.flatMap(a=>[a.index,a.nameIndex]),...out.matrix.map(a=>a.index)].filter(n=>n!==null);
  if(new Set(selected).size!==selected.length)throw new ValidationError('Use each worksheet column for one purpose.');
  if(out.matrix.length&&out.sku!==null)throw new ValidationError('Choose either the exact SKU column or the wide SKU cells for this worksheet.');
  return out;
}

function optionValues(row,mapping){
  const axes=mapping.axes.map(a=>({name:a.label,value:value(row,a.index)}));
  for(const pair of mapping.pairs){
    const name=value(row,pair.nameIndex),option=value(row,pair.index);
    if(name||option)axes.push({name,value:option});
  }
  return axes;
}

function read(filename,buffer,supplied={}){
  if(!supported.test(filename))throw new ValidationError('Choose an Excel, ODS, CSV, TSV or text spreadsheet.');
  const book=parser.parse({filename,buffer,indexed:true}),productNames=new Map(),sheets=[],candidates=[],issues=[];
  for(const [index,sheet] of book.sheets.entries()){
    const map=checkedMapping(sheet,supplied[index]);
    const summary={index,name:sheet.name,columns:sheet.columns,rows:sheet.rows.length,auxiliaryRows:0,mapping:map};
    sheets.push(summary);
    if(!sheet.rows.length||map.mode==='skip')continue;
    if(map.warnings.length){issues.push({sheet:index,message:map.warnings.join(' ')});continue;}
    if(map.mode==='products'){
      if(map.parent===null||map.name===null){issues.push({sheet:index,message:'Choose the exact product code and name on this worksheet.'});continue;}
      for(const row of sheet.rows){
        const parent=value(row,map.parent),name=value(row,map.name);
        if(!parent&&!name)continue;
        if(!validText(parent,240)||!validText(name,240)){issues.push({sheet:index,row:row.sourceRow,message:'This product reference needs a code and name.'});continue;}
        const prior=productNames.get(normalized(parent));
        if(prior&&prior!==name)issues.push({sheet:index,row:row.sourceRow,message:'The same product code has conflicting names.'});
        else productNames.set(normalized(parent),name);
      }
      continue;
    }
    if(map.mode!=='variants'||map.sku===null&&!map.matrix.length||!map.axes.length&&!map.pairs.length&&!map.matrix.length){
      issues.push({sheet:index,message:'Choose an exact SKU column and the option columns, or explicitly skip this worksheet.'});
      continue;
    }
    let priorParent='',priorName='';
    const groupedByHandle=map.parent!==null&&/^(?:(?:url|product) )?handle$/iu.test(sheet.columns.find(c=>c.index===map.parent)?.name||'');
    const imageColumn=sheet.columns.find(c=>/^(?:image src|(?:product )?image url)$/iu.test(c.name))?.index;
    for(const row of sheet.rows){
      let parent=value(row,map.parent),name=value(row,map.name);
      const inherited=map.fillParent&&!parent&&!name&&Boolean(priorParent||priorName);
      if(inherited){parent=priorParent;name=priorName;}
      if((groupedByHandle||map.fillParent)&&parent&&parent===priorParent&&!name)name=priorName;
      if(parent||name){priorParent=parent;priorName=name;}
      const base=optionValues(row,map),barcode=value(row,map.barcode);
      const append=(sku,options,part='')=>{
        const errors=[];
        if(!validText(sku,240))errors.push('This variant needs its exact SKU from the source.');
        if(parent&&!validText(parent,240)||name&&!validText(name,240))errors.push('Use a readable product identifier and name.');
        if(barcode&&(!validText(barcode,240)||/[,;|]/u.test(barcode)))errors.push('Choose one exact original barcode for this variant.');
        if(!options.length||options.some(p=>!validText(p.name,120)||!validText(p.value,120)))errors.push('Every selected option needs an original name and value.');
        if(new Set(options.map(p=>normalized(p.name))).size!==options.length)errors.push('The same option name appears twice on this variant.');
        candidates.push({sheet:index,row:row.sourceRow,part,parent,name,sku,barcode,options,errors,...(inherited?{inheritedParent:true}:{})});
      };
      if(map.matrix.length){
        const filled=map.matrix.map(col=>({...col,sku:value(row,col.index)})).filter(col=>col.sku);
        if(filled.length&&barcode&&filled.length>1)issues.push({sheet:index,row:row.sourceRow,message:'One barcode cannot identify several wide-layout variants.'});
        for(const col of filled)append(col.sku,[...base,{name:map.matrixName,value:col.label}],col.label);
      }else{
        const sku=value(row,map.sku);
        const plainProduct=base.length===1&&normalized(base[0].name)==='title'&&normalized(base[0].value)==='default title';
        const imageOnly=!sku&&!base.some(p=>p.value)&&value(row,imageColumn);
        if(groupedByHandle&&(plainProduct||imageOnly)){summary.auxiliaryRows++;continue;}
        if(sku||base.some(p=>p.value)||parent||name)append(sku,base);
      }
    }
  }
  for(const row of candidates){
    const named=productNames.get(normalized(row.parent));
    if(named&&row.name&&named!==row.name)row.errors.push('The variant and product worksheets give different names for the same code.');
    else if(named&&!row.name)row.name=named;
  }
  if(book.encodingNote)issues.push({message:book.encodingNote,reviewable:true});
  if(!candidates.length)issues.push({message:'This original does not contain any mapped variant rows.'});
  return {sheets,candidates,issues};
}

module.exports={read,supported,normalized,validText};
