'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');

test('calendar dates stay calendar dates while timestamp dates use the business zone',()=>{
 const f=require('../../src/web/presentation/formatting').forTimeZone('America/New_York');
 assert.equal(f.date('2026-10-26'),'Oct 26, 2026');
 assert.equal(f.date('2026-10-26T00:30:00Z'),'Oct 25, 2026');
 assert.equal(f.date(new Date('2026-10-26T00:30:00Z')),'Oct 25, 2026');
 assert.equal(f.date('2026-02-30'),'');
 assert.equal(f.date(null),'');
});
test('one instant formatter follows DST and other business time zones without changing the source date',()=>{
 const formatting=require('../../src/web/presentation/formatting'),ny=formatting.forTimeZone('America/New_York'),tokyo=formatting.forTimeZone('Asia/Tokyo');
 assert.equal(ny.dateTime('2026-03-08T06:30:00Z'),'Mar 8, 2026, 1:30 AM');
 assert.equal(ny.dateTime('2026-03-08T07:30:00Z'),'Mar 8, 2026, 3:30 AM');
 assert.equal(tokyo.date('2026-10-25T23:30:00Z'),'Oct 26, 2026');
 assert.equal(tokyo.date('2026-10-25'),'Oct 25, 2026');
});
test('presentation formatting keeps real zero prices, negative credits and plural units',()=>{
 const f=require('../../src/web/presentation/formatting').forTimeZone('Europe/Paris');
 assert.equal(f.number(12345),'12,345');assert.equal(f.quantity(1,'unit'),'1 unit');assert.equal(f.quantity(2,'unit'),'2 units');
 assert.match(f.money(0,'USD'),/0\.00/);assert.match(f.money(-1250,'USD'),/-.*12\.50/);
});
test('canonical page aliases preserve filters and direct each old destination to one working local page',async()=>{
 const app=express();app.use(require('../../src/web/presentation/navigation').createAliasRouter());app.use((req,res)=>res.status(404).end());
 const cases=[['/signup?plan=growth','/register?plan=growth'],['/receive?po=PO-42','/purchasing/receive?po=PO-42'],['/help','/guide'],['/settings/billing?section=usage','/billing?section=usage'],['/sales?q=blue%20widget&view=unpaid','/orders?q=blue%20widget&view=unpaid'],['/sales/new?customer=someone','/orders/new?customer=someone'],['/sales/orders/so_random?open=money','/orders/so_random?open=money'],['/accounting/books?from=2026-01-01','/money?from=2026-01-01'],['/accounting/accounts','/accounting/chart']];
 for(const [from,to] of cases){const response=await request(app).get(from);assert.equal(response.status,301,from);assert.equal(response.headers.location,to,from);}
 const command=await request(app).post('/sales').send({anything:true});assert.equal(command.status,404,'GET aliases never redirect commands');
 const unknown=await request(app).get('/random-unregistered-destination');assert.equal(unknown.status,404);
});
test('section navigation has the requested five sections, separate footer destinations and no More item',()=>{
 const nav=require('../../src/web/presentation/navigation');assert.deepEqual(nav.sections.map(x=>x.label),['Home','Orders','Stock','Buy','Money']);assert.deepEqual(nav.footer.map(x=>x.label),['Reports','Settings']);
 assert.deepEqual(nav.sections.find(x=>x.label==='Orders').tabs.map(x=>x.label),['Orders','Returns','Customers']);
 assert.deepEqual(nav.sections.find(x=>x.label==='Stock').tabs.map(x=>x.label),['Products','Locations','Transfers','Counts']);
 assert(!JSON.stringify(nav.sections).includes('More'));
});
test('payment presentation separates original amounts, posted credit and cash refund without changing the input',()=>{
 const present=require('../../src/web/presentation/payment-summary').present;
 const partial=Object.freeze({invoiced:true,totalMinor:7409,paidMinor:7409,creditedMinor:2941,refundedMinor:2941,outstandingMinor:0});
 const view=present(partial);assert.equal(view.state,'Partly refunded');assert.deepEqual(view.rows.map(r=>[r.label,r.amountMinor]),[['Invoiced',10350],['Paid',10350],['Credited',2941],['Refunded',2941],['Balance',0]]);
 const full=present({invoiced:true,totalMinor:0,paidMinor:0,creditedMinor:2199,refundedMinor:2199,outstandingMinor:0});assert.equal(full.state,'Refunded');assert.equal(full.rows.find(r=>r.label==='Paid').amountMinor,2199);
 const unpaidCredit=present({invoiced:true,totalMinor:0,paidMinor:0,creditedMinor:2199,refundedMinor:0,outstandingMinor:0});assert.equal(unpaidCredit.state,'Credited');assert.equal(unpaidCredit.rows.find(r=>r.label==='Paid').amountMinor,0);
});
