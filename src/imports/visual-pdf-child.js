'use strict';
// Parse and render untrusted PDF bytes without application credentials.
process.once('message',async({buffer})=>{
 let loading;const timer=setInterval(()=>{if(process.memoryUsage().rss>420*1024*1024)process.exit(2);},100);timer.unref();
 try{
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>32*1024*1024)throw Error('Upload a PDF up to 32 MB.');
  const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');let omitted=false;
  console.log=console.warn=(...args)=>{if(args.some(v=>/Warning:.*(?:image|raster|pixels|ignoring errors|invalid|failed)/i.test(String(v))))omitted=true;};
  // Strict image failures in this version resolve an empty operator list.
  // Surface the warning and refuse the complete source instead.
  loading=pdf.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false,maxImageSize:8000000,stopAtErrors:false,verbosity:pdf.VerbosityLevel.WARNINGS});const doc=await loading.promise;
  if(doc.numPages>30)throw Error('Split documents longer than 30 pages before reading. Every page in the chosen document will be checked.');
  const pages=[];let bytes=0;
  for(let number=1;number<=doc.numPages;number++){
   const page=await doc.getPage(number);
   try{
    await page.getOperatorList();if(omitted)throw Error('A source page contains an image that could not be safely read. Use a smaller readable scan.');
    const base=page.getViewport({scale:1});if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<=0||base.height<=0||base.width>10000||base.height>10000)throw Error('This page exceeds the safe PDF-processing dimensions.');
    const viewport=page.getViewport({scale:Math.min(2,2048/Math.max(base.width,base.height))}),canvas=require('@napi-rs/canvas').createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));await page.render({canvasContext:canvas.getContext('2d'),viewport,canvas}).promise;await new Promise(resolve=>setImmediate(resolve));if(omitted)throw Error('A source page contains an image that could not be safely read.');
    const block=await require('../ai/image-input').prepare(canvas.toBuffer('image/png'));bytes+=block.source.data.length;if(bytes>64*1024*1024)throw Error('The complete rendered file exceeds the safe processing limit. Split its pages into smaller complete sections.');pages.push({page:number,total:doc.numPages,block});
   }finally{page.cleanup();}
  }
  await loading.destroy();loading=null;process.send({pages});
 }catch(error){process.send({error:String(error.message||error).slice(0,1000)});}finally{await loading?.destroy().catch(()=>{});clearInterval(timer);process.disconnect();}
});
