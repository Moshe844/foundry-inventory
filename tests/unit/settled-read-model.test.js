'use strict';
// Page figures (low stock, report cards) while a large import keeps them busy: the page
// gets the last good figure with the time it was counted, one fresh count runs at a
// time, and normal fast counts are always current.
const test=require('node:test'),assert=require('node:assert/strict'),cache=require('../../src/lib/versioned-read-model');
function fixture(){let notify,state,committed;const db={query(){throw Error('Figures must come from the operation.');},onCommittedWrite:callback=>{committed=callback;},
 subscribe(channel,listener,options){notify=listener;state=options.onState;return {ready:Promise.resolve(),connected:true};}};
 return {db,commit:ids=>committed(new Set(ids)),notify:(workspace,business=true)=>notify({payload:JSON.stringify({workspace,business})}),state:value=>state(value)};}
function gate(){let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};}
const read=(f,op,options={})=>cache.settled(f.db,'w1',['figure'],op,{domain:'business',waitMs:30,...options});

test('a fast count is current and cached until the business changes',async()=>{
 const f=fixture();let calls=0;const op=async()=>++calls;
 const first=await read(f,op);assert.equal(first.value,1);assert.equal(first.current,true);assert(first.asOf instanceof Date);
 assert.equal((await read(f,op)).value,1);assert.equal(calls,1);
 f.notify('other');assert.equal((await read(f,op)).value,1,'another business never refreshes this one');
 f.notify('w1');const after=await read(f,op);assert.equal(after.value,2);assert.equal(after.current,true);
});

test('while a fresh count is slow the page gets the last good figure, and only one count runs',async()=>{
 const f=fixture();let calls=0;assert.equal((await read(f,async()=>++calls)).value,1);const counted=(await read(f,async()=>0)).asOf;
 f.notify('w1');const slow=gate();const op=async()=>{calls++;await slow.promise;return 'fresh';};
 const pages=await Promise.all(Array.from({length:5},()=>read(f,op)));
 for(const page of pages){assert.equal(page.value,1);assert.equal(page.current,false);assert.equal(page.asOf.getTime(),counted.getTime());}
 assert.equal(calls,2,'five page loads started one fresh count, not five');
 slow.open();await new Promise(r=>setImmediate(r));
 const done=await read(f,async()=>assert.fail('the finished count is reused'));assert.equal(done.value,'fresh');assert.equal(done.current,true);
});

test('with no earlier figure the page waits for the count instead of showing nothing',async()=>{
 const f=fixture();const slow=gate();setTimeout(()=>slow.open('first'),80);
 const page=await read(f,()=>slow.promise);assert.equal(page.value,'first');assert.equal(page.current,true);
});

test('a failed count shows the last good figure; with none the failure reaches the page',async()=>{
 const f=fixture(),busy=Object.assign(Error('canceling statement due to statement timeout'),{code:'57014'});
 await assert.rejects(read(f,async()=>{throw busy;}),/statement timeout/);
 assert.equal((await read(f,async()=>7)).value,7);f.notify('w1');
 const page=await read(f,async()=>{throw busy;});assert.equal(page.value,7);assert.equal(page.current,false);
 const retried=await read(f,async()=>8);assert.equal(retried.value,8,'the failure is not remembered');assert.equal(retried.current,true);
});

test('a figure the caller does not keep is shown once and never served as the last good one',async()=>{
 const f=fixture(),keep=value=>value!=='partial';
 assert.equal((await read(f,async()=>'whole',{keep})).value,'whole');f.notify('w1');
 assert.equal((await read(f,async()=>'partial',{keep})).value,'partial');f.notify('w1');
 const slow=gate();const page=await read(f,()=>slow.promise,{keep});slow.open('later');
 assert.equal(page.value,'whole');assert.equal(page.current,false);
});

test('a change during a count makes its result not current, and the next load counts again',async()=>{
 const f=fixture();const slow=gate();const pending=read(f,()=>slow.promise,{waitMs:10000});
 await new Promise(r=>setImmediate(r));f.notify('w1');
 const joined=read(f,async()=>assert.fail('one count at a time'),{waitMs:10000});slow.open('before the change');
 assert.equal((await pending).current,true);const late=await joined;assert.equal(late.value,'before the change');assert.equal(late.current,false);
 const next=await read(f,async()=>'after the change');assert.equal(next.value,'after the change');assert.equal(next.current,true);
});

test('same-process writes and a lost notification connection both outdate kept figures',async()=>{
 const f=fixture();let n=0;const op=async()=>++n;
 assert.equal((await read(f,op)).value,1);f.commit(['w1']);assert.equal((await read(f,op)).value,2);
 f.state(false);assert.equal((await read(f,op)).value,3);
 assert.equal(cache.status(f.db).settledFigures,1);
});
