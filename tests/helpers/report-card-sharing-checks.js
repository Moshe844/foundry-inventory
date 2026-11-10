'use strict';const assert=require('node:assert/strict');
async function check(t,db,ctx){
 const reports=require('../../src/reports/postgres-service'),business=require('../../src/reports/business-reports'),actor={role:'owner'},input={},permission=require('../../src/actions/permissions');
 const whole=await reports.run(db,ctx,actor,{dataset:'catalogue',summary:true,aggregate:'count'},{limit:2});
 const grouped=await reports.run(db,ctx,actor,{dataset:'catalogue',groups:['product'],aggregate:'count',sort:'count',direction:'desc'},{limit:3,includeOverall:true});
 assert(grouped.hasMore,'The exact overall count must include groups beyond the displayed page');assert.equal(String(grouped.overall.value),String(whole.rows[0].count));assert.equal(grouped.rows.length,2);
 // Low stock is counted in items: each low variant once, however many places it is low in.
 const expected=Number((await db.query('SELECT count(DISTINCT sku)::text n FROM ('+require('../../src/reports/low-stock-source').source()+') source',[ctx.workspaceId])).rows[0].n);
 const lowStock=require('../../src/reports/low-stock-count'),reader={...db},original=reports.run,originalLow=lowStock.compute;let builds=0;const mock=t.mock.method(reports,'run',async(...args)=>{builds++;return original(...args);}),lowMock=t.mock.method(lowStock,'compute',async(...args)=>{builds++;return originalLow(...args);});let results;
 try{results=await Promise.all(Array.from({length:50},(_,n)=>require('../../src/lib/request-read-cache').run(()=>business.cards(reader,{...ctx,actorId:'report-reader-'+n},{...actor,id:'report-reader-'+n},input))));}finally{mock.mock.restore();lowMock.mock.restore();}
 assert.equal(builds,business.definitions.length,'Concurrent people with the same report permissions must build each card once');
 for(const cards of results){assert.deepEqual(cards,results[0]);const low=cards.find(c=>c.key==='low-stock');assert.equal(low.value,expected.toLocaleString('en-US')+(expected===1?' item':' items'));assert.equal(low.chartLabel,'Low-stock items by location');assert(low.trend.length<=12);}
 results[0][0].value='mutated local response';assert.notEqual(results[1][0].value,results[0][0].value,'One response must not mutate another person’s shared result');
 const restricted=await business.cards(reader,ctx,{role:'staff',permissions:JSON.stringify([permission.VIEW])},input);assert(restricted.length>0);for(const key of ['sales','profit','customers','suppliers','taxes','low-stock'])assert(!restricted.some(c=>c.key===key),'Cached owner summaries must not bypass '+key+' permissions');
 return {reportCardReaders:50,cardBuilds:builds,groupedCatalogueOverall:Number(grouped.overall.value),displayedGroups:grouped.rows.length,lowStockPositions:expected,lowStockLocationGroups:results[1].find(c=>c.key==='low-stock').trend.length,privateResponseClones:true,permissionSetsIsolated:true,paidCalls:0};
}
module.exports={check};
