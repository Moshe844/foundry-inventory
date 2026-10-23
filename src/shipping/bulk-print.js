'use strict';
const {ValidationError}=require('../domain/errors');
const CHUNK=10,MAX_BYTES=32*1024*1024,MAX_PAGES=20;
async function download(url,{timeoutMs=5000}={}){try{const response=await require('../connections/providers/store-network').fetchStore(url,{signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw new Error('unavailable');return Buffer.from(await response.arrayBuffer());}catch{throw new ValidationError('A saved carrier label could not be downloaded. Retry printing; do not buy the label again.');}}
let busy=false;
async function build(documents,format,options={}){if(busy)throw new ValidationError('Another label group is being prepared. Try printing again shortly. No postage was purchased.');busy=true;try{return await combine(documents,format,options);}finally{busy=false;}}
async function combine(documents,format,{download:read=download}={}){
 const deadline=Date.now()+45000,remaining=()=>{const n=deadline-Date.now();if(n<1)throw new ValidationError('Combining these labels took too long. Print a smaller group; no postage was purchased.');return n;};
 if(!['PDF','ZPL'].includes(format)||!Array.isArray(documents)||!documents.length||documents.length>CHUNK)throw new ValidationError('Print 1 to '+CHUNK+' saved labels at a time.');
 if(documents.some(d=>d.format!==format))throw new ValidationError('Print labels with different printer formats in separate groups.');
 const buffers=[];let bytes=0;for(const doc of documents){const buffer=await read(doc.url,{timeoutMs:Math.min(5000,remaining())});bytes+=buffer.length;if(bytes>MAX_BYTES)throw new ValidationError('These labels are too large to combine. Print a smaller group.');buffers.push(buffer);}
 if(format==='ZPL'){if(buffers.some(b=>!b.toString().trim().startsWith('^XA')||!b.toString().includes('^XZ')))throw new ValidationError('The carrier did not return a readable ZPL label. Retry its saved download without buying again.');return Buffer.concat(buffers.flatMap(b=>[b,Buffer.from('\n')]));}
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),{createCanvas}=require('@napi-rs/canvas'),PDF=require('pdfkit'),output=new PDF({autoFirstPage:false,compress:true}),chunks=[];let outputBytes=0,pages=0;
 const completed=new Promise((resolve,reject)=>{output.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>64*1024*1024)output.destroy(new ValidationError('The combined labels are too large. Print fewer at once.'));else chunks.push(chunk);});output.on('end',()=>resolve(Buffer.concat(chunks)));output.on('error',reject);});
 // Consume a rejected stream even if a malformed source throws first.
 completed.catch(()=>{});
 try{for(const buffer of buffers){if(buffer.subarray(0,5).toString()!=='%PDF-')throw new ValidationError('The carrier did not return a readable PDF label. Retry its saved download without buying again.');let document;
  let loading;try{loading=pdfjs.getDocument({data:new Uint8Array(buffer),useSystemFonts:true,isEvalSupported:false});document=await loading.promise;
   if(pages+document.numPages>MAX_PAGES)throw new ValidationError('Print at most '+MAX_PAGES+' label pages together.');
   for(let i=1;i<=document.numPages;i++){remaining();const page=await document.getPage(i),size=page.getViewport({scale:1}),view=page.getViewport({scale:300/72});
    if(!Number.isFinite(view.width*view.height)||view.width*view.height>12_000_000)throw new ValidationError('This label page is too large for combined printing. Print the original carrier PDF.');
    const canvas=createCanvas(Math.ceil(view.width),Math.ceil(view.height));try{await page.render({canvasContext:canvas.getContext('2d'),viewport:view}).promise;output.addPage({size:[size.width,size.height],margin:0});output.image(canvas.toBuffer('image/png'),0,0,{width:size.width,height:size.height});pages++;}finally{canvas.width=1;canvas.height=1;page.cleanup();}
   }
  }catch(error){if(error instanceof ValidationError)throw error;throw new ValidationError('A saved PDF label could not be combined. Print its original carrier PDF without buying again.');}finally{await loading?.destroy();}
 }output.end();return await completed;}catch(error){output.destroy();throw error;}
}
module.exports={build,CHUNK};
