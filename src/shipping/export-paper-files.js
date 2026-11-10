'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency');
async function pdf(p,{draft=true,reviewer=''}={}){
 const PDF=require('pdfkit'),fontPath=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),font=require('fontkit').openSync(fontPath);
 const strings=[p.exporter.name,p.exporter.address,p.from.name,p.from.address,p.to.name,p.to.address,p.deliveryTerms,reviewer,...p.lines.flatMap(l=>[l.sku,l.description,l.unit])];
 for(const s of strings)for(const c of String(s||'')){if(c.codePointAt(0)>=32&&!font.hasGlyphForCodePoint(c.codePointAt(0)))throw new ValidationError('A recorded character cannot be printed by this PDF font. Preserve the original facts and use a separately reviewed document.');}
 return new Promise((resolve,reject)=>{
  const doc=new PDF({size:'A4',margin:42,bufferPages:true,info:{Title:(draft?'Draft ':'')+'Export packet '+p.shipmentNumber,Author:p.exporter.name}}),chunks=[];let bytes=0;
  doc.on('data',c=>{bytes+=c.length;if(bytes>2*1024*1024){doc.destroy(new Error('The export packet exceeds two megabytes.'));return;}chunks.push(c);});doc.on('error',reject);doc.on('end',()=>resolve(Buffer.concat(chunks)));
  try{
   doc.registerFont('Trade',fontPath).font('Trade');const width=doc.page.width-84,amount=n=>money.format(n,p.currency),room=h=>{if(doc.y+h>doc.page.height-65)doc.addPage();};
   const heading=label=>{doc.fillColor('#332a6b').fontSize(19).text((draft?'DRAFT · ':'')+label);doc.fillColor('#171824').fontSize(10).text('Reference CI-'+p.shipmentNumber+'-'+p.sourceHash.slice(0,8)+' · Prepared '+p.preparedDate);doc.text('Shipment '+p.shipmentNumber+' · Order '+p.orderNumber+' · Currency '+p.currency);doc.moveDown();};
   heading('COMMERCIAL INVOICE');doc.fontSize(11).text('Exporter: '+p.exporter.name);doc.fontSize(9).text(p.exporter.address);doc.text('Exporter country code: '+p.exporter.countryCode);doc.moveDown(.5);doc.fontSize(11).text('Dispatch from: '+p.from.name);doc.fontSize(9).text(p.from.address);doc.text('Dispatch country: '+p.from.country);doc.moveDown(.5);doc.fontSize(11).text('Consignee: '+p.to.name);doc.fontSize(9).text(p.to.address);doc.text('Destination country: '+p.to.country);if(p.to.phone)doc.text('Phone: '+p.to.phone);if(p.to.email)doc.text('Email: '+p.to.email);doc.moveDown(.5).text('Reason for shipment: sale').text('Agreed delivery terms: '+p.deliveryTerms);doc.moveDown();
   for(const [i,l]of p.lines.entries()){
    room(100);doc.fillColor('#332a6b').fontSize(11).text((i+1)+'. '+l.sku+' · '+l.description,{width});doc.fillColor('#171824').fontSize(9).text(l.quantity+' '+l.unit+' · HS '+l.hsCode+' · Origin '+l.originCountry);
    doc.text('Recorded unit price '+amount(l.unitPriceMinor)+' · Gross '+amount(l.grossMinor)+' · Discount '+amount(l.discountMinor));doc.text('Net goods '+amount(l.goodsNetMinor)+' · Other sale charges '+amount(l.chargesMinor)+' · Tax '+amount(l.taxMinor));doc.text('Net weight '+(l.netWeightGrams/1000).toFixed(3)+' kg');doc.moveDown(.6);
   }
   room(170);doc.moveDown(.3).fontSize(12).text('Recorded net goods value: '+amount(p.totals.goodsNetMinor));doc.fontSize(10).text('Other recorded sale charges: '+amount(p.totals.chargesMinor));doc.text('Recorded tax: '+amount(p.totals.taxMinor));doc.text('Recorded sale total for these packed units: '+amount(p.totals.totalMinor));doc.moveDown().fontSize(9).text('Values and allocations come from the confirmed sale pricing. The exporter reviews customs valuation, classification, origin and destination requirements. This packet creates no second customer invoice or receivable. No customs declaration, export filing, certificate or carrier submission is made by StockChief.');
   doc.moveDown().text(draft?'Private draft — not reviewed for use.':'Packet facts reviewed in StockChief by '+reviewer+'. This record does not replace any signature, certificate or filing required by the destination.');
   doc.addPage();heading('PACKING LIST');doc.fontSize(10).text('Dispatch: '+p.from.name+' · '+p.from.country).text('Consignee: '+p.to.name+' · '+p.to.country).text('Parcels: '+p.boxes.length).text('Gross measured weight: '+(p.grossWeightGrams/1000).toFixed(3)+' kg').text('Confirmed goods net weight: '+(p.netWeightGrams/1000).toFixed(3)+' kg');doc.moveDown();
   for(const [i,b]of p.boxes.entries()){room(36);doc.fontSize(10).text('Parcel '+(i+1)+' · '+(b.weightGrams/1000).toFixed(3)+' kg'+(b.lengthMm&&b.widthMm&&b.heightMm?' · '+b.lengthMm+' × '+b.widthMm+' × '+b.heightMm+' mm':''));}
   doc.moveDown();for(const l of p.lines){room(45);doc.fontSize(10).text(l.sku+' · '+l.quantity+' '+l.unit+' · '+l.description,{width});}
   room(55);doc.moveDown().fontSize(9).text('Products above cover the shipment as a whole. Individual contents per parcel are not assigned by this list. Physical packing, carrier handoff and customs clearance are separate records.');
   const pages=doc.bufferedPageRange();for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.page.margins.bottom=0;doc.fontSize(8).fillColor('#666666').text((draft?'DRAFT · ':'')+p.shipmentNumber+' · '+(i+1)+' / '+pages.count,42,doc.page.height-38,{width,align:'center',lineBreak:false});}
   doc.end();
  }catch(error){doc.destroy();reject(error);}
 });
}
module.exports={pdf};
