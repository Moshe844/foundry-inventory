'use strict';
const {ValidationError}=require('../domain/errors');
const root='https://api.orderful.com/transactions';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function client(apiKey,transport=fetch){
  const headers={'orderful-api-key':apiKey,'orderful-api-version':'v4',Accept:'application/json'};
  async function request(url,options){
    try{return await transport(url,{...options,signal:AbortSignal.timeout(12000),redirect:'manual'});}
    catch{throw new ValidationError('The Orderful request outcome is unknown. Check the test transaction before sending again.');}
  }
  async function body(response){
    if(!response.ok)throw new ValidationError('Orderful test API returned HTTP '+response.status+'.');
    if(Number(response.headers.get('content-length')||0)>2_000_000)throw new ValidationError('The EDI document exceeds the 2 MB limit.');
    const reader=response.body?.getReader();if(!reader)throw new ValidationError('Orderful returned no document.');
    let size=0;const chunks=[];
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000){await reader.cancel();throw new ValidationError('The EDI document exceeds the 2 MB limit.');}chunks.push(Buffer.from(part.value));}}
    finally{reader.releaseLock();}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ValidationError('This connection requires the Orderful JSON relationship format.');}
  }
  async function transaction(id){
    if(!uuid.test(id))throw new ValidationError('Enter the Orderful transaction UUID.');
    const meta=await body(await request(root+'/'+id,{headers}));
    if(meta.id!==id||meta.stream!=='test')throw new ValidationError('Choose a transaction from the test stream.');
    return meta;
  }
  async function message(id){
    if(!uuid.test(id))throw new ValidationError('Enter the Orderful transaction UUID.');
    let response=await request(root+'/'+id+'/message',{headers});
    if(response.status===302){
      const location=response.headers.get('location');let target;
      try{target=new URL(location);}catch{throw new ValidationError('Orderful returned an invalid download URL.');}
      if(target.protocol!=='https:'||target.port||target.username||target.password||
        !/(?:^|\.)(?:orderful\.com|amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net|cloudfront\.net)$/.test(target.hostname))
        throw new ValidationError('The Orderful document storage host could not be verified.');
      // A signed download is a separate request. The organization API key belongs only on api.orderful.com.
      response=await request(target.href,{headers:{Accept:'application/json'}});
    }
    return body(response);
  }
  async function send(type,seller,buyer,document){
    if(!['855_PURCHASE_ORDER_ACKNOWLEDGMENT','856_SHIP_NOTICE_MANIFEST','810_INVOICE'].includes(type))throw new ValidationError('Unsupported outbound EDI document.');
    const result=await body(await request(root,{method:'POST',headers:{...headers,'Content-Type':'application/json'},
      body:JSON.stringify({type,stream:'test',senderId:seller,receiverId:buyer,message:document})}));
    if(!['ACCEPTED','FAILED'].includes(result.status)||!result.id)throw new ValidationError('Orderful did not confirm its processing status. Reconcile the original request.');
    return {id:String(result.id),status:result.status};
  }
  async function inbox(con,start,end,cursor){
    const params=new URLSearchParams({stream:'test',direction:'in',senderId:con.buyer,receiverId:con.seller,validationStatus:'VALID',createdAtStart:start,createdAtEnd:end,limit:'50'});
    if(cursor)params.set('nextCursor',cursor);
    const result=await body(await request(root+'?'+params,{headers}));
    if(!Array.isArray(result.data))throw new ValidationError('Orderful returned an unexpected inbox response.');
    const next=result.metadata?.pagination?.links?.next;
    let nextCursor=null;
    if(next){
      const url=new URL(next);
      if(url.origin!=='https://api.orderful.com'||url.pathname!=='/transactions'||!url.searchParams.get('nextCursor'))throw new ValidationError('Orderful returned an unrecognized inbox cursor.');
      nextCursor=url.searchParams.get('nextCursor');
    }
    return {items:result.data,nextCursor};
  }
  return {transaction,message,send,inbox};
}
module.exports={client};
