'use strict';

function stocktakeWorkbook(report){
  const XLSX=require('xlsx');
  const workbook=XLSX.utils.book_new();
  function sheet(name,headers,rows){
    if(rows.length>=1048576)throw new (require('../domain/errors').ValidationError)('This pack exceeds the Excel worksheet row limit.');
    const ws=XLSX.utils.aoa_to_sheet([headers,...rows]);
    ws['!cols']=headers.map(h=>({wch:Math.max(15,h.length+4)}));
    XLSX.utils.book_append_sheet(workbook,ws,name);
  }
  sheet('Period',['Fiscal year starts','Closing date','Approved count lines','Scope'],[[report.span.start,report.span.end,report.counts.length,'Posted stock valuation and completed warehouse count reviews.']]);
  sheet('Closing valuation',['Currency','Account','SKU','Closing value'],report.rows.map((r,i)=>[r.Currency,r.Account,r.SKU,report.values[i]]));
  sheet('Approved count lines',['Date','Location','Reference','SKU','Before','Counted','Difference','Currency','Change in value','Approved by'],
    report.counts.map((r,i)=>[r.Date,r.Location,r.Reference,r.SKU,Number(r.Before),Number(r.Counted),Number(r.Difference),r.Currency,report.countValues[i],r['Approved by']]));
  return XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true});
}

module.exports={stocktakeWorkbook};
