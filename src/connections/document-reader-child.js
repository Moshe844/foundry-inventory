'use strict';
// A parser process only. No application config, model, database, credentials,
// network client, business services or tenant data is loaded here.
process.once('message',async input=>{
 const memoryWatch=setInterval(()=>{if(process.memoryUsage().rss>320*1024*1024)process.exit(2);},100);memoryWatch.unref();
 try{if(!input||!Buffer.isBuffer(input.buffer)||input.buffer.length>20*1024*1024)throw Error('INVALID_DOCUMENT');
  if(require('node:path').extname(input.filename).toLowerCase()==='.pdf'){
   // pdfjs 6.2 can resolve getOperatorList before rejecting its strict stream
   // error. In this single-document child, also collect the public warning
   // path: oversized rasters are skipped BEFORE decode, then the whole
   // document fails review. Never accept a silently omitted invoice image.
   let warning=false;console.log=console.warn=(...args)=>{if(args.some(value=>String(value).startsWith('Warning:')))warning=true;};
   const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs'),path=require('node:path'),task=pdf.getDocument({data:new Uint8Array(input.buffer),useSystemFonts:true,isEvalSupported:false,maxImageSize:8000000,stopAtErrors:false,verbosity:pdf.VerbosityLevel.WARNINGS,standardFontDataUrl:path.join(path.dirname(require.resolve('pdfjs-dist/package.json')),'standard_fonts').replaceAll('\\','/')+'/'});
   try{const doc=await task.promise;if(doc.numPages>20)throw Error('TOO_MANY_PAGES');for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);await page.getOperatorList();page.cleanup();if(warning)throw Error('INCOMPLETE_PDF_IMAGE');}}finally{await task.destroy();}
  }
  const text=await require('../foundry/document-text').extractText({filename:input.filename,buffer:input.buffer},{maxPages:20,maxOcrPages:3,maxTextCharacters:120000});process.send({text},()=>process.exit(0));}
 catch(error){process.send({error:error.name==='ValidationError'?error.message:'StockChief could not read this document completely. Review the original.'},()=>process.exit(0));}
});
