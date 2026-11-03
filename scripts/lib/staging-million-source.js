'use strict';const fs=require('node:fs'),path=require('node:path');
const warehouses=['NJ-Main','NY-Store','PA-DC','CA-West','TX-South'];
const bins=Array.from({length:20},(_,n)=>({name:warehouses[n%5]+' Count zone '+(Math.floor(n/5)+1),warehouse:warehouses[n%5]}));
function item(n){const p=Math.floor(n/10),v=n%10,category=['Apparel','Grocery','Electronics','Hardware'][p%4];return {p,v,category,lot:category==='Grocery',name:category+' product '+p,code:'MILLION-'+p+'-'+v};}
function write(root,kind,count,{run,skuCount=50000}={}){
 if(!['catalogue','stock150k','stockMillion'].includes(kind)||!Number.isSafeInteger(count)||count<1||count>1000000||!Number.isSafeInteger(skuCount)||skuCount<10||skuCount>50000||skuCount%10||!/^[a-z0-9-]{6,60}$/.test(run||''))throw Error('Invalid bounded scale source.');
 const file=path.join(root,kind+'-'+count+'.csv');if(fs.existsSync(file))return file;
 fs.writeFileSync(file,kind==='catalogue'?'Product,SKU,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Barcode,Cost,Price,Supplier,Category,Lot Tracked\n':'Product,SKU,Location,Quantity,Unit cost,Lot,Lot Tracked,Expiry date,Source reference\n');
 for(let start=0;start<count;start+=5000){let chunk='';for(let n=start;n<Math.min(start+5000,count);n++){
  const r=item(n%skuCount);if(kind==='catalogue')chunk+=[r.name,r.code,['Size','Flavor','Model','Voltage'][r.p%4],'Option '+Math.floor(r.v/5),['Color','Bag size','Color','Length'][r.p%4],'Value '+r.v%5,'0091'+String(n).padStart(9,'0'),2,5,'Supplier '+r.p%200,r.category,r.lot?'Yes':'No'].join(',')+'\n';
  else chunk+=[r.name,r.code,kind==='stockMillion'?bins[Math.floor(n/skuCount)%20].name:warehouses[Math.floor(n/skuCount)%5],kind==='stock150k'?1:1+Math.floor(n/(skuCount*5)),2,r.lot?'LOT-'+r.code:'',r.lot?'Yes':'No',r.lot?'2027-12-31':'',run+'-'+kind+'-'+n].join(',')+'\n';
 }fs.appendFileSync(file,chunk);}return file;
}module.exports={write,warehouses,bins};
