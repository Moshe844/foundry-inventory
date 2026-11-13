'use strict';
// Job 184 test fake: the QuickBooks and Xero invoice and bill endpoints, over
// fetch, so the real adapters run end to end without a live provider. Every
// other host is refused. Knobs: `next` ('refuse' rejects the next post with a
// 400; 'lost' keeps the post and drops every answer, retries included, until
// the test clears it), `tamper`
// (an external id whose read-back shows a different total) and `add` (a
// document someone entered in the books themselves).
const cents=v=>Math.round(Number(v)*100),dollars=c=>Math.round(c)/100;

function install(t){
  const previous=global.fetch;
  const state={posts:{quickbooks:0,xero:0},docs:{quickbooks:[],xero:[]},requests:new Map(),next:null,tamper:null,
    add(provider,doc){state.docs[provider].push(doc);return doc;}};
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const read=(provider,doc)=>{const copy=structuredClone(doc);if(state.tamper&&String(copy.Id||copy.InvoiceID)===String(state.tamper)){if(provider==='quickbooks')copy.TotalAmt=Number(copy.TotalAmt)+1;else copy.Total=Number(copy.Total)+1;}return copy;};

  function quickbooks(url,method,options){
    const parts=url.pathname.split('/').filter(Boolean);// v3 company realm entity [id]
    const entity=parts[3];
    if(method==='POST'&&['invoice','bill'].includes(entity)){
      const request=url.searchParams.get('requestid');
      const drop=()=>{throw new TypeError('fetch failed: the connection closed after the books took the document');};
      if(state.requests.has('qb:'+request)){if(state.next==='lost')drop();return json({[entity==='invoice'?'Invoice':'Bill']:read('quickbooks',state.requests.get('qb:'+request))});}
      if(state.next==='refuse'){state.next=null;return json({Fault:{Error:[{Message:'Invalid reference',Detail:'The account or tax code is not valid.'}]}},400);}
      const body=JSON.parse(options.body),lines=body.Line.reduce((sum,l)=>sum+cents(l.Amount),0),tax=cents(body.TxnTaxDetail?.TotalTax||0);
      state.posts.quickbooks++;
      const doc={...body,Id:'qb-'+(state.docs.quickbooks.length+1),SyncToken:'0',Entity:entity==='invoice'?'Invoice':'Bill',TotalAmt:dollars(lines+tax),
        Line:[...body.Line,...(entity==='invoice'?[{DetailType:'SubTotalLineDetail',Amount:dollars(lines)}]:[])]};
      state.docs.quickbooks.push(doc);state.requests.set('qb:'+request,doc);
      if(state.next==='lost')drop();
      return json({[doc.Entity]:read('quickbooks',doc)});
    }
    if(method==='GET'&&entity==='query'){
      const query=url.searchParams.get('query'),m=/^select \* from (Invoice|Bill) where DocNumber = '((?:[^'\\]|\\.)*)'$/.exec(query||'');
      if(!m)return json({Fault:{Error:[{Message:'Unsupported fake query'}]}},400);
      const number=m[2].replace(/\\(.)/g,'$1');
      return json({QueryResponse:{[m[1]]:state.docs.quickbooks.filter(d=>d.Entity===m[1]&&d.DocNumber===number).map(d=>read('quickbooks',d))}});
    }
    if(method==='GET'&&['invoice','bill'].includes(entity)){
      const doc=state.docs.quickbooks.find(d=>d.Id===decodeURIComponent(parts[4])&&d.Entity.toLowerCase()===entity);
      return doc?json({[doc.Entity]:read('quickbooks',doc)}):json({Fault:{Error:[{Message:'Object Not Found'}]}},404);
    }
    return json({Fault:{Error:[{Message:'Unsupported fake QuickBooks call '+method+' '+url.pathname}]}},400);
  }

  function xero(url,method,options){
    const path=url.pathname.replace(/^\/api\.xro\/2\.0/,'');
    if(method==='POST'&&path==='/Invoices'){
      const key=options.headers?.['idempotency-key'];
      const drop=()=>{throw new TypeError('fetch failed: the connection closed after the books took the document');};
      if(key&&state.requests.has('xero:'+key)){if(state.next==='lost')drop();return json({Invoices:[read('xero',state.requests.get('xero:'+key))]});}
      if(state.next==='refuse'){state.next=null;return json({Message:'A validation exception occurred',Elements:[{ValidationErrors:[{Message:'Account code is not valid.'}]}]},400);}
      const body=JSON.parse(options.body).Invoices[0];
      state.posts.xero++;
      const items=body.LineItems.map(l=>({...l,LineAmount:dollars(cents(l.UnitAmount)*Number(l.Quantity))}));
      const sub=items.reduce((s,l)=>s+cents(l.LineAmount),0),tax=items.reduce((s,l)=>s+cents(l.TaxAmount||0),0);
      const doc={...body,LineItems:items,InvoiceID:'xero-'+(state.docs.xero.length+1),Date:'/Date('+Date.parse(body.Date+'T00:00:00Z')+'+0000)/',DateString:body.Date+'T00:00:00',
        SubTotal:dollars(sub),TotalTax:dollars(tax),Total:dollars(sub+tax),UpdatedDateUTC:'/Date('+Date.now()+'+0000)/'};
      state.docs.xero.push(doc);if(key)state.requests.set('xero:'+key,doc);
      if(state.next==='lost')drop();
      return json({Invoices:[read('xero',doc)]});
    }
    if(method==='GET'&&path==='/Invoices'){
      const numbers=(url.searchParams.get('InvoiceNumbers')||'').split(','),contacts=(url.searchParams.get('ContactIDs')||'').split(',');
      return json({Invoices:state.docs.xero.filter(d=>numbers.includes(d.InvoiceNumber)&&contacts.includes(d.Contact?.ContactID)).map(d=>read('xero',d))});
    }
    const one=/^\/Invoices\/(.+)$/.exec(path);
    if(method==='GET'&&one){const doc=state.docs.xero.find(d=>d.InvoiceID===decodeURIComponent(one[1]));return doc?json({Invoices:[read('xero',doc)]}):json({Message:'Not found'},404);}
    return json({Message:'Unsupported fake Xero call '+method+' '+path},400);
  }

  global.fetch=async(value,options={})=>{
    const url=new URL(typeof value==='string'?value:value.url),method=String(options.method||'GET').toUpperCase();
    if(url.hostname==='sandbox-quickbooks.api.intuit.com')return quickbooks(url,method,options);
    if(url.hostname==='api.xero.com')return xero(url,method,options);
    throw new Error('The fake books refuse a real network call to '+url.hostname+'.');
  };
  t.after(()=>{global.fetch=previous;});
  return state;
}
module.exports={install};
