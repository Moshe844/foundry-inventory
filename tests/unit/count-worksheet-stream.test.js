'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{csvRows}=require('../../src/web/public/count-worksheet');
test('count CSV streams quoted newlines and escaped quotes correctly across every chunk boundary',async()=>{
 const text='SKU,Location,Counted quantity\r\n"A,1","NJ ""Main""\nBin",0\r\nB,NY,3.75';
 for(let size=1;size<=text.length;size++){const chunks=(async function*(){for(let i=0;i<text.length;i+=size)yield text.slice(i,i+size);})();const rows=[];for await(const row of csvRows(chunks))rows.push(row);assert.deepEqual(rows,[['SKU','Location','Counted quantity'],['A,1','NJ "Main"\nBin','0'],['B','NY','3.75']]);}
});
test('count CSV rejects incomplete quoted fields and oversized fields before saving them',async()=>{
 async function consume(text){for await(const row of csvRows([text]))void row;}
 await assert.rejects(consume('SKU,"unfinished'),/incomplete/);await assert.rejects(consume('x'.repeat(17000)),/oversized/);
});
