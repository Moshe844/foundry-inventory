'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),capacity=require('../../scripts/lib/staging-capacity-lease');
const now=Date.parse('2026-11-08T12:00:00Z'),jobId='synthetic-million-job',release='a'.repeat(40);
const lease={jobId,release,databaseId:capacity.DATABASE_ID,observedAt:new Date(now-30000).toISOString(),capacityBytes:58007654000,usedBytes:47000000000,maximumDatabaseBytes:capacity.MAX_DATABASE_BYTES};
test('hosted capacity follows a fresh physical budget and protects the recovery reserve',()=>{
 assert.equal(capacity.check(lease,{jobId,release,databaseBytes:44300000000,now}),44300000000,'A safe database above the old 38/44 GB constants is admitted');
 const denied=[null,{...lease,jobId:'another-job'},{...lease,release:'b'.repeat(40)},{...lease,databaseId:'production'},{...lease,observedAt:new Date(now-90001).toISOString()},{...lease,observedAt:new Date(now+5001).toISOString()},{...lease,capacityBytes:56*1024**3},{...lease,usedBytes:lease.capacityBytes-capacity.RECOVERY_BYTES-capacity.TELEMETRY_MARGIN_BYTES+1},{...lease,maximumDatabaseBytes:capacity.MAX_DATABASE_BYTES+1},{...lease,usedBytes:-1},{...lease,usedBytes:NaN}];
 for(const invalid of denied)assert.throws(()=>capacity.check(invalid,{jobId,release,databaseBytes:44300000000,now}),error=>error.code==='qualification_capacity_paused');
 assert.throws(()=>capacity.check(lease,{jobId,release,databaseBytes:capacity.MAX_DATABASE_BYTES+1,now}));
});

test('Render telemetry uses actual observation time and never renews an unrelated job',async()=>{
 const monitor=require('../../scripts/lib/staging-capacity-monitor'),series={labels:[{field:'resource',value:capacity.DATABASE_ID}],unit:'bytes',values:[{timestamp:new Date(now-30000).toISOString(),value:47000000000}]};
 const measured=await monitor.measure('not-exported',{now,fetcher:async url=>({ok:true,json:async()=>[{...series,values:series.values.map(p=>({...p,value:url.includes('disk-capacity')?58007654000:p.value}))}]})});
 assert.equal(Date.parse(measured.observedAt),now-30000);assert.equal(measured.usedBytes,47000000000);
 for(const invalid of [[],[{...series,unit:'gigabytes'}],[{...series,labels:[]}],[{...series,values:[{timestamp:new Date(now-90001).toISOString(),value:1}]}]])assert.throws(()=>monitor.sample(invalid,now));
 let writes=0;const db={query:async(sql,args)=>{if(!args)return {rows:[{bytes:'44300000000'}]};writes++;assert.equal(args[0],jobId);assert.equal(args[1],release);assert.match(sql,/j\.kind='qualification.staging-million'/);assert.match(sql,/Synthetic ERP release/);return {rowCount:0};}};
 const fresh={...measured,observedAt:new Date().toISOString()};assert.equal((await monitor.renew(db,jobId,release,fresh)).renewed,false);assert.equal(writes,1);assert.doesNotMatch(JSON.stringify(fresh),/not-exported/);
});
test('every forced pre-commit check sees the current lease rather than a cached admission',async()=>{
 let clock=now,current={...lease},queries=0;const db={query:async(_sql,args)=>{queries++;assert.deepEqual(args,[jobId,release]);return {rows:[{bytes:'44300000000',lease:current}]};}};
 const probe=capacity.create(db,{jobId,release,now:()=>clock});assert.equal(await probe(),44300000000);await probe();assert.equal(queries,1);
 current=null;await assert.rejects(probe({force:true}),error=>error.code==='qualification_capacity_paused');assert.equal(queries,2);
 current={...lease};clock+=10001;await probe();assert.equal(queries,3);
 clock+=90001;await assert.rejects(probe({force:true}),/monitor expired/);
 assert.throws(()=>capacity.create(db,{jobId:'../../private',release}));assert.throws(()=>capacity.create(db,{jobId,release:'production'}));
});
