'use strict';
// Render the existing StockChief vector mark at Marketplace dimensions.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
async function main(){
 const output=path.resolve(__dirname,'../output/bigcommerce-production-20261125/listing-assets');fs.mkdirSync(output,{recursive:true});
 const mark=fs.readFileSync(path.resolve(__dirname,'../src/web/views/components/brand-symbol.ejs'),'utf8').trim();
 const icon=mark.replace('width="24" height="24"','width="200" height="200"').replace('currentColor','#4f46e5');
 await sharp(Buffer.from(icon)).png().toFile(path.join(output,'stockchief-icon.png'));
 const logo='<svg xmlns="http://www.w3.org/2000/svg" width="350" height="130"><rect width="350" height="130" fill="white"/>'+mark.replace('width="24" height="24"','x="20" y="29" width="72" height="72"').replace('currentColor','#4f46e5')+'<text x="108" y="78" font-family="Arial,sans-serif" font-size="36" font-weight="700" fill="#172033">StockChief</text></svg>';
 await sharp(Buffer.from(logo)).png().toFile(path.join(output,'stockchief-logo.png'));
 console.log(output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
