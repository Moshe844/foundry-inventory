'use strict';

const {createCanvas}=require('@napi-rs/canvas');
const PDFDocument=require('pdfkit');

async function scannedTablePdf(options={}){
  const picture=scannedTableImage(options);
  const document=new PDFDocument({size:[1100,480],margin:0,compress:false});
  const chunks=[];document.on('data',(chunk)=>chunks.push(chunk));
  const finished=new Promise((resolve,reject)=>{
    document.on('end',()=>resolve(Buffer.concat(chunks)));document.on('error',reject);
  });
  document.image(picture,0,0,{width:1100,height:480});
  if(options.selectableTitle)document.fontSize(10).text('Inventory opening stock',5,5);
  document.end();
  return finished;
}

function scannedTableImage(options={}){
  const canvas=createCanvas(1100,480);const drawing=canvas.getContext('2d');
  drawing.fillStyle='#fff';drawing.fillRect(0,0,1100,480);
  drawing.fillStyle='#000';drawing.font='30px Arial';
  const items=options.items||[['Desk Lamp','LAMP-10','3'],['Wall Light','LIGHT-20','4']];
  for(const [y,values] of [[70,['Product','SKU','Quantity']],
    [145,items[0]],[220,items[1]]]){
    [40,470,850].forEach((x,index)=>drawing.fillText(values[index],x,y));
  }
  return canvas.toBuffer(options.format==='jpeg'?'image/jpeg':'image/png');
}

module.exports={scannedTablePdf,scannedTableImage};
