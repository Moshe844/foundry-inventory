'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const sorter=require('../../src/connections/agent-mail-triage');

test('current requests and document evidence distinguish orders, invoice questions, delivery mail and junk',()=>{
  const examples=[
    [{subject:'Where is PO-701?',bodyText:'Can you check our purchase order?'},'customer','question'],
    [{subject:'PO 901',bodyText:'Receiving dock 14.'},'customer','order'],
    [{subject:'Invoice',bodyText:'We have a question about tax.'},null,'question'],
    [{subject:'A document for you',bodyText:'Invoice # 901\nInvoice date November 11\nAmount due 90.00'},'supplier','invoice'],
    [{subject:'Fwd: New order',bodyText:'For your records.\n> Please place this order.'},'customer','message'],
    [{subject:'Invoice 876',bodyText:'How much tax should we pay?'},null,'question'],
    [{subject:'Facture mensuelle',bodyText:'Ci-joint.',attachments:[{filename:'facture_14.pdf'}],listMail:true},null,'invoice'],
    [{subject:'Bon de commande',bodyText:'Ci-joint notre bon de commande.',attachments:[{filename:'bon-de-commande-74.pdf'}]},null,'order'],
    [{subject:'What happens next?',bodyText:'Is there any chance you can help?'},null,'question'],
    [{subject:'Shipping',bodyText:'Please find the packing slip.',attachments:[{filename:'Packing slip.pdf'}]},'supplier','delivery'],
    [{subject:'Re: Purchase order',bodyText:'Thanks.\n\n> We would like to place an order.'},'customer','message'],
    [{subject:'Invoice 88',bodyText:'Please pay now.',providerJunk:true,attachments:[{filename:'Invoice 88.pdf'}]},'supplier','bulk'],
    [{subject:'Promotional announcement',bodyText:'How much could you save?',listMail:true},null,'bulk'],
    [{subject:'Document packet',attachments:[{filename:'Invoice.pdf'},{filename:'Purchase order.pdf'}]},'supplier','review'],
  ];
  for(const [message,kind,want] of examples){
    const decided=sorter.decide(message,kind);
    assert.equal(decided.category,want,message.subject);assert(decided.reason.length>10);
  }
});

test('Gmail carries provider junk, current HTML text and bounded time-window page tokens through the real adapter',async t=>{
  const old=global.fetch;t.after(()=>{global.fetch=old;});
  const received='2026-11-10T10:00:00.000Z',calls=[];
  global.fetch=async raw=>{
    const url=new URL(raw);calls.push(url);
    if(url.pathname.endsWith('/messages'))return Response.json(url.searchParams.get('pageToken')==='next'?
      {messages:[{id:'junk'}]}:{messages:[{id:'html'}],nextPageToken:'next'});
    const id=url.pathname.split('/').at(-1);
    return Response.json({id,internalDate:String(Date.parse(received)),labelIds:id==='junk'?['SPAM']:['INBOX'],
      payload:{mimeType:'text/html',headers:[{name:'From',value:'Known Sender <sender@example.test>'},{name:'List-Id',value:'list'}],
        body:{data:Buffer.from('<h2>Can you help?</h2><script>Purchase order</script><blockquote>Previous buying request</blockquote><span hidden>Invisible claim</span>').toString('base64url')}}});
  };
  const gmail=require('../../src/connections/providers/gmail'),query={credentials:{accessToken:'gmail-fixture'},
    since:'2026-11-10T09:45:00.000Z',until:'2026-11-10T11:00:00.000Z'};
  const a=await gmail.pollPage(query),b=await gmail.pollPage({...query,cursor:a.next});
  assert.match(a.messages[0].bodyText,/Can you help\?/);assert.doesNotMatch(a.messages[0].bodyText,/Purchase order/);
  assert.match(a.messages[0].bodyText,/Previous buying request/);
  assert.doesNotMatch(a.messages[0].triageBodyText,/Previous buying request|Invisible claim/);
  assert.equal(a.messages[0].listMail,true);assert.equal(b.messages[0].providerJunk,true);assert.equal(b.next,null);
  const lists=calls.filter(url=>url.pathname.endsWith('/messages'));
  assert.equal(lists[0].searchParams.get('includeSpamTrash'),'true');
  assert.match(lists[0].searchParams.get('q'),/-in:trash .*before:/);
  assert.equal(lists[1].searchParams.get('q'),lists[0].searchParams.get('q'));
});

test('Microsoft consumes the exact next page, retains attachment metadata and marks junk by source folder',async t=>{
  const old=global.fetch;t.after(()=>{global.fetch=old;});
  const calls=[],base='https://graph.microsoft.com/v1.0',at='2026-11-10T10:00:00Z';
  const row=(id,extra={})=>({id,receivedDateTime:at,subject:'Document for review',from:{emailAddress:{address:'known@example.test'}},
    body:{contentType:'html',content:'<p>Can you confirm?</p><script>Purchase order</script>'},...extra});
  global.fetch=async raw=>{
    const url=new URL(raw);calls.push(url);
    if(url.pathname.endsWith('/attachments')){
      if(url.searchParams.get('$skiptoken')==='files')return Response.json({value:[{id:'order',name:'Purchase order.pdf',contentBytes:'Yg=='}]});
      return Response.json({value:[{id:'invoice',name:'Invoice.pdf',contentBytes:'YQ=='}],
        '@odata.nextLink':base+'/me/messages/inbox1/attachments?$skiptoken=files'});
    }
    if(url.pathname.includes('/inbox/')){
      if(url.searchParams.get('$skiptoken')==='mail')return Response.json({value:[row('inbox2')]});
      return Response.json({value:[row('inbox1',{hasAttachments:true})],
        '@odata.nextLink':base+'/me/mailFolders/inbox/messages?$skiptoken=mail'});
    }
    return Response.json({value:[row(url.pathname.includes('/junkemail/')?'junk':'archive')]});
  };
  const graph=require('../../src/connections/providers/microsoft365'),options={credentials:{accessToken:'graph-fixture'},
    since:'2026-11-10T09:45:00.000Z',until:'2026-11-10T11:00:00.000Z'};
  let page=await graph.pollPage(options);
  assert.deepEqual(page.messages[0].attachments.map(a=>a.filename),['Invoice.pdf','Purchase order.pdf']);
  assert.match(page.messages[0].bodyText,/Can you confirm\?/);assert.doesNotMatch(page.messages[0].bodyText,/Purchase order/);
  assert.equal((page=await graph.pollPage({...options,cursor:page.next})).messages[0].messageId,'inbox2');
  assert.equal((page=await graph.pollPage({...options,cursor:page.next})).messages[0].messageId,'archive');
  assert.equal((page=await graph.pollPage({...options,cursor:page.next})).messages[0].providerJunk,true);
  assert.equal(page.next,null);
  await assert.rejects(graph.pollPage({...options,cursor:{folder:'inbox',url:'https://another.example.test/v1.0/me/mailFolders/inbox/messages'}}),/outside/);
  assert.equal(calls.filter(url=>url.searchParams.has('$skiptoken')).length,2);
});

test('Microsoft defers an unavailable mailbox page to the durable queue after one provider attempt',async t=>{
  const original=global.fetch;
  let attempts=0;
  t.after(()=>{global.fetch=original;});
  global.fetch=async()=>{attempts++;return new Response('',{status:503,headers:{'Retry-After':'180'}});};
  const graph=require('../../src/connections/providers/microsoft365');
  await assert.rejects(graph.pollPage({credentials:{accessToken:'graph-fixture'},
    since:'2026-11-10T09:45:00.000Z',until:'2026-11-10T11:00:00.000Z'}),
  error=>error.code==='provider_unavailable'&&error.retryAfterMs===180000);
  assert.equal(attempts,1);
});
