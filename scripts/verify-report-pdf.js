'use strict';

const fs=require('node:fs');
const path=require('node:path');
const reportExports=require('../src/reports/exports');

async function main(){
  const rows=Array.from({length:65},(_,index)=>({
    product:`Café coupler ${index+1}`,sku:`RPT-${String(index+1).padStart(3,'0')}`,
    location:index%2?'Downtown Store':'Main Warehouse',on_hand:index+1,
    unit_cost:`USD ${(index+1)/10}`,
  }));
  const columns=['product','sku','location','on_hand','unit_cost'];
  const result={config:{title:'Café inventory - verified source records'},columns,rows,
    displayRows:rows,asOf:'2026-10-09T00:00:00.000Z'};
  const output=await reportExports.pdf(result);
  const target=path.resolve(__dirname,'../.tmp/report-pdf-qa.pdf');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,output);
  process.stdout.write(`${target}\n`);
}
main().catch((error)=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1;});
