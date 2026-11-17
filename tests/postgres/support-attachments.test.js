'use strict';
process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const files=require('../../src/operations/support-attachments');

const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),Buffer.alloc(120,7)]);
const PDF=Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('a support file is accepted by what it is, not by its name',()=>{
  assert.equal(files.sniff(PNG,'anything.bin'),'image/png');
  assert.equal(files.sniff(PDF,'note.pdf'),'application/pdf');
  assert.equal(files.sniff(Buffer.from('a,b\n1,2\n'),'stock.csv'),'text/csv');
  assert.equal(files.sniff(Buffer.from('<script>alert(1)</script>'),'shot.png'),null,'text pretending to be a picture');
  assert.equal(files.sniff(Buffer.from('MZ\x90\x00'),'setup.exe'),null);
  assert.equal(files.sniff(Buffer.from('<svg onload=alert(1)>'),'logo.svg'),null,'pictures that can run code are refused');
  assert.equal(files.sniff(Buffer.from([0x50,0x4B,0x03,0x04,1,2]),'archive.zip'),null);
  assert.equal(files.sniff(Buffer.from([0x50,0x4B,0x03,0x04,1,2]),'stock.xlsx'),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(()=>files.prepare([{filename:'big.png',buffer:Buffer.concat([PNG,Buffer.alloc(10*1024*1024)])}]),/larger than 10 MB/);
  assert.throws(()=>files.prepare(Array.from({length:6},(_,i)=>({filename:i+'.png',buffer:PNG}))),/up to 5 files/);
  assert.throws(()=>files.prepare([{filename:'x.png',buffer:Buffer.from('not a picture')}]),/can't be attached/);
  const [one]=files.prepare([{filename:'..\\..\\evil\u0007"name.png',buffer:PNG}]);
  assert.equal(one.name,'evilname.png');assert.equal(one.type,'image/png');
});

test('Help and support: an owner sends a pasted screenshot and a PDF, and only they can open them',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,browser,csrf}=f;
  await f.subscribe('growth');
  const page=await browser.get('/support').expect(200);
  assert.match(page.text,/data-support-files/);assert.match(page.text,/Paste a screenshot, drop files here/);
  assert.match(page.text,/enctype="multipart\/form-data"/);

  // The first message, with a picture and a PDF.
  const sent=await browser.post('/support/message').set('Accept','application/json')
    .field('_csrf',csrf(page.text)).field('requestKey','supportform_files_1').field('sourcePath','/imports')
    .field('body','The import says row 14 has no SKU.')
    .attach('attachments',PNG,{filename:'Screenshot 2026-11-17 10.25.52.png',contentType:'image/png'})
    .attach('attachments',PDF,{filename:'Delivery note.pdf',contentType:'application/pdf'});
  assert.equal(sent.status,200,sent.text);
  const url=sent.body.url,id=url.split('/').pop();
  const stored=(await db.query('SELECT id,message_id,file_name,content_type,byte_size FROM support_attachments WHERE request_id=$1 ORDER BY file_name',[id])).rows;
  assert.deepEqual(stored.map(r=>[r.file_name,r.content_type,r.message_id]),[['Delivery note.pdf','application/pdf',null],['Screenshot 2026-11-17 10.25.52.png','image/png',null]]);

  // Sending the same form again saves nothing twice.
  const again=await browser.post('/support/message').set('Accept','application/json')
    .field('_csrf',csrf(page.text)).field('requestKey','supportform_files_1').field('sourcePath','/imports')
    .field('body','The import says row 14 has no SKU.')
    .attach('attachments',PNG,{filename:'Screenshot 2026-11-17 10.25.52.png',contentType:'image/png'})
    .attach('attachments',PDF,{filename:'Delivery note.pdf',contentType:'application/pdf'});
  assert.equal(again.body.url,url);
  assert.equal((await db.query('SELECT count(*)::int n FROM support_attachments WHERE request_id=$1',[id])).rows[0].n,2);

  // The conversation shows the picture and the PDF; the picture opens in the page, the PDF downloads.
  const thread=await browser.get(url).expect(200);
  const png=stored.find(r=>r.content_type==='image/png'),pdf=stored.find(r=>r.content_type==='application/pdf');
  assert.match(thread.text,new RegExp('<img src="'+url+'/attachments/'+png.id+'"'));
  assert.match(thread.text,new RegExp('href="'+url+'/attachments/'+pdf.id+'" download="Delivery note.pdf"'));
  const image=await browser.get(url+'/attachments/'+png.id).buffer(true).expect(200);
  assert.equal(image.headers['content-type'],'image/png');assert.equal(image.headers['x-content-type-options'],'nosniff');
  assert.match(image.headers['content-disposition'],/^inline;/);assert.match(image.headers['content-security-policy'],/sandbox/);
  assert.ok(Buffer.compare(image.body,PNG)===0,'the same bytes come back');
  const download=await browser.get(url+'/attachments/'+pdf.id).buffer(true).expect(200);
  assert.equal(download.headers['content-type'],'application/pdf');assert.match(download.headers['content-disposition'],/^attachment; filename="Delivery note.pdf"/);

  // A reply that is only a screenshot.
  const reply=await browser.post(url+'/reply').set('Accept','application/json')
    .field('_csrf',csrf(thread.text)).field('requestKey','supportreply_files_1').field('body','')
    .attach('attachments',PNG,{filename:'image.png',contentType:'image/png'});
  assert.equal(reply.status,200,reply.text);
  const updates=await browser.get(url+'/updates').expect(200);
  const last=updates.body.messages.at(-1);
  assert.equal(last.body,'Sent 1 attachment.');
  assert.deepEqual(last.attachments.map(a=>[a.name,a.type,a.image]),[['image.png','image/png',true]]);

  // A disguised file is refused and nothing is saved.
  const refused=await browser.post(url+'/reply').set('Accept','application/json')
    .field('_csrf',csrf(thread.text)).field('requestKey','supportreply_files_2').field('body','one more')
    .attach('attachments',Buffer.from('<script>alert(1)</script>'),{filename:'shot.png',contentType:'image/png'});
  assert.equal(refused.status,400);assert.match(refused.body.error.message,/can't be attached/);
  assert.equal((await db.query("SELECT count(*)::int n FROM support_messages WHERE request_id=$1 AND body='one more'",[id])).rows[0].n,0);

  // Someone else signed in cannot open the files, even with the exact address.
  const auth=require('../../src/domain/postgres-auth-service'),password='Other-owner-'+Date.now()+'!x';
  await auth.createBusiness(db,{name:'Other owner',businessName:'Other business',email:'other-support@example.test',password});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'support-files-fixture'});
  t.after(()=>app.locals.sessionStore.close());
  const other=request.agent(app),login=await other.get('/login');
  await other.post('/login').type('form').send({_csrf:csrf(login.text),email:'other-support@example.test',password});
  await other.get(url+'/attachments/'+png.id).expect(404);
  await other.get(url).expect(404);
  // And the support desk's file address is for support staff only.
  await assert.rejects(require('../../src/operations/postgres-support-conversations').attachment(db,f.owner.accountId,id,png.id,{staff:true}),/restricted/);
});
