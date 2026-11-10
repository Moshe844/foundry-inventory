'use strict';
// One untrusted source, no credentials, application configuration or network.
const MAX=2000000;
process.once('message',async input=>{
 const timer=setInterval(()=>{if(process.memoryUsage().rss>420*1024*1024)process.exit(2);},100);timer.unref();let worker=null,loading=null;
 try{
  const path=require('node:path'),buffer=input.buffer,ext=path.extname(input.filename).toLowerCase();
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)throw Error('Use a contract file up to 20 MB.');
  const pages=[];let length=0;
  const add=(text,page,sourceKind='text',sourceName='',extra={})=>{text=String(text).replace(/\u0000/g,'').trim();length+=text.length;if(length>MAX)throw Error('This complete document exceeds the processing limit. Split its sections into separate readable files.');pages.push({page,text,sourceKind,sourceName,...extra});};
  const ocr=async(bytes,{allowEmpty=false}={})=>{worker ||=await require('../foundry/document-text').createOcrWorker();const result=await worker.recognize(bytes);if(!allowEmpty&&!result.data.text?.trim())throw Error('A source page could not be read. Upload a clearer original.');return result.data.text;};
  if(buffer.subarray(0,5).toString()==='%PDF-'){
   const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');let omitted=false;
   console.log=console.warn=(...args)=>{if(args.some(v=>/Warning:.*(?:image|raster|pixels)/i.test(String(v))))omitted=true;};
   loading=pdf.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,maxImageSize:8000000,stopAtErrors:true});const doc=await loading.promise;
   if(doc.numPages>100)throw Error('Split contracts longer than 100 pages into their complete sections. No pages have been silently omitted.');
   for(let number=1;number<=doc.numPages;number++){
    const page=await doc.getPage(number);try{const operators=await page.getOperatorList();if(omitted)throw Error('A source page contains an image that could not be safely read.');const content=await page.getTextContent(),nativeText=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join(''),imageOps=new Set(['paintImageXObject','paintInlineImageXObject','paintImageMaskXObject','paintImageXObjectRepeat','paintImageMaskXObjectGroup','paintInlineImageXObjectGroup','paintJpegXObject'].map(k=>pdf.OPS[k]).filter(n=>n!==undefined)),hasImages=operators.fnArray.some(n=>imageOps.has(n));let text=nativeText,sourceKind='text',visualObservation='';
    if(hasImages||nativeText.trim().length<20){const imageText=await ocr(await require('../foundry/document-text').renderPdfPage(page),{allowEmpty:true});sourceKind=nativeText.trim().length>=20?'mixed':'scan';visualObservation=imageText.trim()?'Page image checked; compare OCR-only characters and amounts with the original.':'Page image checked; no readable image text was detected. Check non-text marks in the original.';text=nativeText.trim().length>=20?nativeText+'\n\n[Image reading of the same original page; duplicate native text is not another contract term]\n'+imageText:imageText;}
    add(text,number,sourceKind,'',{nativeText,visualObservation});}finally{page.cleanup();}
   }
  }else if(ext==='.docx'){
   const zip=await require('jszip').loadAsync(buffer),{DOMParser}=require('@xmldom/xmldom');let number=0;
   const files=Object.keys(zip.files).filter(n=>/^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(n)).sort((a,b)=>a==='word/document.xml'?-1:b==='word/document.xml'?1:a.localeCompare(b));
   if(!files.includes('word/document.xml'))throw Error('This Word file has no complete document body.');
   for(const name of files){const xml=await zip.files[name].async('string');if(xml.length>4000000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('This Word part cannot be safely read.');let invalid=false;
    const doc=new DOMParser({errorHandler:{warning:()=>{invalid=true;},error:()=>{invalid=true;},fatalError:()=>{invalid=true;}}}).parseFromString(xml,'text/xml');if(invalid)throw Error('A Word source part is invalid; no document text was silently omitted.');
    const walk=node=>{if(node.nodeType!==1)return '';if(['t','delText','instrText'].includes(node.localName))return (node.localName==='delText'?'[Tracked deletion: ':'')+node.textContent+(node.localName==='delText'?']':'');if(['tab','br','cr'].includes(node.localName))return '\n';if(['footnoteReference','endnoteReference','commentReference'].includes(node.localName))return '['+node.localName+' '+node.getAttribute('w:id')+']';let out='';for(let child=node.firstChild;child;child=child.nextSibling)out+=walk(child);if(['footnote','endnote','comment'].includes(node.localName))out='['+node.localName+' '+node.getAttribute('w:id')+'] '+out;if(node.localName==='r'&&node.getElementsByTagNameNS('*','strike').length)out='[Struck-out text; review: '+out+']';return out+(['p','tr'].includes(node.localName)?'\n':'');};
    add(walk(doc.documentElement),++number,'word_text',name);
   }
   for(const [name,file]of Object.entries(zip.files).filter(([name,file])=>!file.dir&&name.startsWith('word/media/'))){const bytes=await file.async('nodebuffer');const block=await require('../ai/image-input').prepare(bytes),imageText=await ocr(Buffer.from(block.source.data,'base64'),{allowEmpty:true});add(imageText,++number,'scan',name,{visualObservation:imageText.trim()?'Image text checked; compare its reading with the original.':'Image checked; no readable text. Check the original visual or decorative mark.'});}
   if(Object.keys(zip.files).some(n=>n.startsWith('word/embeddings/')))throw Error('This Word contract contains embedded files. Upload a complete PDF including those schedules, so every contractual price and term can be checked.');
  }
  else if(['.txt','.csv','.tsv'].includes(ext)){const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);if(/[\u0000]/.test(text))throw Error('Use a readable UTF-8 contract text file.');add(text,1);}
  else{
   const codecs=require('../imports/image-codecs'),sharp=require('sharp');
   if(codecs.kind(buffer)){const decoded=await codecs.decode(buffer);let number=0;for(const frame of decoded.frames){const png=await sharp(Buffer.from(frame.pixels),{raw:{width:frame.width,height:frame.height,channels:4}}).withMetadata({orientation:frame.orientation}).png().toBuffer(),block=await require('../ai/image-input').prepare(png);add(await ocr(Buffer.from(block.source.data,'base64')),++number,'scan');}}
   else{const block=await require('../ai/image-input').prepare(buffer);add(await ocr(Buffer.from(block.source.data,'base64')),1,'scan');}
  }
  if(!pages.some(p=>p.text.length>=20))throw Error('This original does not contain enough readable contract text.');
  process.send({pages},()=>process.exit(0));
 }catch(error){process.send({error:String(error.message||'This complete contract could not be read.').slice(0,500)},()=>process.exit(0));}
 finally{if(worker)await worker.terminate();if(loading)await loading.destroy();}
});
