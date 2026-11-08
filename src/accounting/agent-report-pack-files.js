'use strict';

const money=require('../domain/currency');

function boardPdf(report){
  const PDF=require('pdfkit');
  const doc=new PDF({size:'A4',layout:'landscape',margin:40,info:{Title:'Board or investor pack',Author:'StockChief'}});
  const font=require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf');
  const result=new Promise((resolve,reject)=>{
    const chunks=[];
    doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  });
  const palette=['#234e68','#b25c29','#3e7552'];
  const measures=[['Revenue','revenue'],['Cost of goods','cost'],['Gross profit','gross']];
  for(const [index,series] of (report.series.length?report.series:[{currency:'',points:[]}]).entries()){
    if(index)doc.addPage();
    doc.font(font).fillColor('#192731').fontSize(22).text('Board or investor pack',40,40);
    doc.fontSize(11).text(report.span.start+' to '+report.span.end+(series.currency?'  |  '+series.currency:''),40,76);
    if(!series.points.length){doc.text('No posted revenue or cost of goods in this period.',40,120);continue;}
    const values=series.points.flatMap(p=>measures.map(([,k])=>p[k]));
    const high=Math.max(0,...values),low=Math.min(0,...values),height=150;
    const scale=height/(high-low||1),zero=130+high*scale;
    const left=95,width=650,step=width/series.points.length,bar=Math.min(22,step/5);
    doc.fontSize(9).text(money.format(high,series.currency),40,125,{width:50});
    if(low<high)doc.text(money.format(low,series.currency),40,275,{width:50});
    doc.strokeColor('#91a0a8').moveTo(left,zero).lineTo(left+width,zero).stroke();
    for(const [i,point] of series.points.entries()){
      const center=left+step*(i+.5);
      for(const [j,[,k]] of measures.entries()){
        const v=point[k];if(v!==0)doc.rect(center+(j-1.5)*bar,Math.min(zero,zero-v*scale),bar-2,Math.abs(v*scale)).fill(palette[j]);
      }
      doc.fillColor('#192731').text(point.month,center-30,290,{width:60,align:'center'});
    }
    for(const [i,[label]] of measures.entries()){
      doc.rect(95+i*175,323,10,10).fill(palette[i]);doc.fillColor('#192731').text(label,110+i*175,322);
    }
    const columns=[40,175,330,485,635];
    const data=[['Month','Revenue','Cost of goods','Gross profit','Coverage'],...report.rows.filter(r=>r.Currency===series.currency)
      .map(r=>[r.Month,r.Revenue,r['Cost of goods'],r['Gross profit'],r.Coverage])];
    for(const [i,line] of data.entries())line.forEach((v,j)=>doc.fontSize(10).text(v,columns[j],362+i*21,{width:130}));
    doc.fontSize(9).text('Source: posted StockChief journal entries. Coverage reflects the accounting start date.',40,530);
  }
  doc.end();return result;
}

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

module.exports={boardPdf,stocktakeWorkbook};
