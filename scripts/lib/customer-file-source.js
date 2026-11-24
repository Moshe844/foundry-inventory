'use strict';
// A customer-shaped opening file, the same shape as the 150,000-row website
// test: new products in five sizes with barcode, category, cost, price,
// quantity and one warehouse. Synthetic qualification data only.
const fs=require('node:fs'),path=require('node:path');
const categories=['Hardware','Plumbing','Electrical','Paint','Garden'],sizes=['XS','S','M','L','XL'];
function write(root,{products=30000,location='NJ-Main'}={}){
 if(!Number.isSafeInteger(products)||products<1||products>200000)throw Error('Invalid bounded customer source.');
 const file=path.join(root,'customer-'+products*5+'.csv');if(fs.existsSync(file))return file;
 fs.writeFileSync(file,'Product,SKU,Option1 Name,Option1 Value,Barcode,Category,Unit cost,Price,Quantity,Location\n');
 for(let start=0;start<products;start+=2000){let chunk='';
  for(let p=start;p<Math.min(start+2000,products);p++){const category=categories[p%5];
   for(let v=0;v<5;v++)chunk+=['Customer '+category+' item '+p,'CU-'+String(p).padStart(6,'0')+'-'+sizes[v],'Size',sizes[v],'0750'+String(p*5+v).padStart(9,'0'),category,(2+(p%7)*0.5).toFixed(2),(5+(p%9)).toFixed(2),1+((p+v)%12),location].join(',')+'\n';}
  fs.appendFileSync(file,chunk);}
 return file;
}
module.exports={write};
