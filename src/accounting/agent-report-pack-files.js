'use strict';

// Job 165: the year-end stocktake and valuation workbook for the accountant.
function stocktakeWorkbook(report){
  const XLSX=require('xlsx');
  const workbook=XLSX.utils.book_new();
  function sheet(name,headers,rows){
    if(rows.length>=1048576)throw new (require('../domain/errors').ValidationError)('This pack exceeds the Excel worksheet row limit.');
    const ws=XLSX.utils.aoa_to_sheet([headers,...rows]);
    ws['!cols']=headers.map(h=>({wch:Math.max(15,h.length+4)}));
    XLSX.utils.book_append_sheet(workbook,ws,name);
  }
  const roll=report.rollForward||[];
  const summary=[['Business',report.business||''],['Financial year',report.span.start+' to '+report.span.end],['Valuation method',report.method||''],
    ['Approved count lines',report.counts.length]];
  if(report.pending)summary.push(['Counts not approved by the year end (left out)',report.pending]);
  if(report.writeDowns)summary.push(['Write-downs in the year',report.writeDowns.length]);
  if(report.stocktakes)summary.push(['Annual stocktakes signed off in the year',report.stocktakes.length]);
  if(report.accounting?.problem)summary.push(['Books',report.accounting.problem]);
  for(const c of roll)summary.push([],['Stock value · '+c.currency,''],['Opening stock value',c.opening],['Received',c.receipts],['Cost of goods sold',c.cogs],
    ['Counts and adjustments',c.adjustments],['Written off and written down',c.writeoffs],['Transfers',c.transfers],['Production and other',c.other],
    ['Closing stock value in stock records',c.closing],['Closing stock value in the books',c.booksClosing],['Stock in transit in the books',c.booksTransit],
    ['Books less stock records',c.difference]);
  summary.push([],['Scope','Posted stock valuation, the year’s stock value changes, write-downs, completed count reviews and count worksheets, and signed-off annual stocktakes. Counts not approved by the year end are left out.']);
  sheet('Summary',['Item','Value'],summary);
  sheet('Closing valuation',['Currency','Account','SKU','Closing value'],report.rows.map((r,i)=>[r.Currency,r.Account,r.SKU,report.values[i]]));
  if(roll.length)sheet('Stock by location',['Currency','Location','Opening','Received','Cost of goods sold','Counts and adjustments','Written off','Transfers','Production and other','Closing'],
    roll.flatMap(c=>c.locations.map(l=>[c.currency,l.name,l.opening,l.receipts,l.cogs,l.adjustments,l.writeoffs,l.transfers,l.other,l.closing])));
  sheet('Approved count lines',['Date','Location','Reference','SKU','Before','Counted','Difference','Currency','Change in value','Approved by','Source'],
    report.counts.map((r,i)=>[r.Date,r.Location,r.Reference,r.SKU,Number(r.Before),Number(r.Counted),Number(r.Difference),r.Currency,report.countValues[i],r['Approved by'],r.Source||'Count review']));
  if(report.writeDowns)sheet('Write-downs',['Date','SKU','Location','Quantity','Currency','Value before','Value after','Written down','Evidence','Approved by'],
    report.writeDowns.map(w=>[w.date,w.sku,w.location,w.quantity,w.currency,w.before,w.after,w.writtenDown,w.evidence,w.approver]));
  if(report.stocktakes)sheet('Stocktakes',['Stocktake','Signed off','Positions counted','Positions with a difference','Net change in value'],
    report.stocktakes.map(s=>[s.title,s.date,s.positions,s.differences,s.value]));
  return XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true});
}

module.exports={stocktakeWorkbook};
