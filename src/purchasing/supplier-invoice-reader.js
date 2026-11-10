'use strict';
const path=require('node:path');
async function read(file){
 const ext=path.extname(file.filename).toLowerCase();
 if(['.xlsx','.xls'].includes(ext))return await require('../connections/document-reader').read(file);
 const pages=await require('../documents/contract-source').read({...file,invoiceLayout:true});if(pages.some(p=>p.requiresSourceConfirmation))return pages.map(p=>p.text).join('\n\n');for(const p of pages){
  const table=require('./supplier-invoice-visual-table'),overlap=(a,b)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
  if(p.sourceKind==='mixed'&&p.nativeGeometryComplete&&p.nativeWords?.length&&p.rasterRegions?.length&&!p.nativeWords.some(n=>p.rasterRegions.some(r=>overlap(n,r)))){const imageWords=(p.ocrWords||[]).filter(w=>p.rasterRegions.some(r=>(w.x0+w.x1)/2>=r.x0&&(w.x0+w.x1)/2<=r.x1&&(w.y0+w.y1)/2>=r.y0&&(w.y0+w.y1)/2<=r.y1)),combined=table.text({ocrWords:p.nativeWords.concat(imageWords)});if(combined){p.text=combined;p.sourceKind='separate_native_and_raster';continue;}}
  const visual=table.text(p);if(visual){if(p.sourceKind==='mixed')p.text=p.nativeText+'\n\n[Image reading of the same original page; duplicate native text is not another contract term]\n'+visual;else if(p.sourceKind==='scan')p.text=visual;}else if(p.sourceKind==='text'&&p.nativeGeometryComplete&&p.nativeWords?.length){const native=table.text({ocrWords:p.nativeWords});if(native)p.text=native;}
 }
 for(const page of pages)if(page.sourceKind==='word_text'&&page.invoiceText!==undefined)page.text=page.invoiceText;
 if(pages.some(p=>p.sourceKind==='mixed')){
  const parser=require('./supplier-invoice-source-parser'),native=pages.map(p=>p.nativeText??p.text).join('\n\n'),visual=pages.map(p=>p.sourceKind==='mixed'?p.text.split('[Image reading of the same original page; duplicate native text is not another contract term]')[1]||p.text:p.text).join('\n\n');
  let a,b;try{a=parser.parse(native);}catch{}try{b=parser.parse(visual);}catch{}
  const economic=d=>JSON.stringify({number:d.invoiceNumber,po:d.purchaseOrder,currency:d.currency,issued:d.issueDate,due:d.dueDate,terms:d.paymentTerms,total:d.total,tax:d.tax,charges:d.charges,rows:d.rows.map(r=>({code:String(r.code||r.description||'').toLowerCase(),q:r.quantity,w:r.secondaryQuantity,p:r.unitCostMinor,per:r.priceQuantity,total:r.lineTotalMinor,basis:r.quantityBasis,lot:r.lotCode,serials:r.serials,tax:r.lineTaxMinor,original:r.sourceLineTotalMinor}))});
  if(a&&b&&economic(a)===economic(b))return native;
  if(!a&&b){try{let nativeRows=[];try{nativeRows=parser.parse(native,{allowUnreconciled:true}).rows;}catch{}const line=r=>JSON.stringify({code:String(r.code||r.description||'').toLowerCase(),q:r.quantity,w:r.secondaryQuantity,p:r.unitCostMinor,per:r.priceQuantity,basis:r.quantityBasis,lot:r.lotCode,serials:r.serials,total:r.lineTotalMinor,tax:r.lineTaxMinor,original:r.sourceLineTotalMinor}),available=b.rows.map(line);for(const r of nativeRows){const i=available.indexOf(line(r));if(i<0)throw new Error('Native and raster invoice rows conflict');available.splice(i,1);}const m=parser.metadata(native,b.currency),values={currency:b.currency,invoice:b.invoiceNumber,po:b.purchaseOrder,issued:b.issueDate,due:b.dueDate,terms:b.paymentTerms,total:b.total,tax:b.tax};if(Object.entries(m).every(([k,v])=>values[k]===v))return visual;}catch{}}
  // Conflicting native and visual readings remain complete for owner review.
 }
 return pages.map(p=>p.text).join('\n\n');
}
module.exports={read};
