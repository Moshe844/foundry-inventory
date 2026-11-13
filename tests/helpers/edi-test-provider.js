'use strict';

// A scripted EDI network for tests only (job 185). It speaks the provider
// interface of src/connections/edi-providers.js and is never registered by
// production code: a test registers it, sends retailer orders into it and
// reads what StockChief sent back.
const {randomUUID}=require('node:crypto');
const {ValidationError}=require('../../src/domain/errors');

function ediNetwork({apiKey='edi-test-key'}={}){
  const documents=new Map(),sent=[];let loseNext=false;
  const clone=v=>JSON.parse(JSON.stringify(v));
  // A retailer sends one document (an 850 order by default) to a seller.
  function deliver({sender,receiver,message,type='850_PURCHASE_ORDER',id=randomUUID(),stream='test'}){
    documents.set(id,{meta:{id,stream,direction:'in',senderId:sender,receiverId:receiver,ediTransactionType:type,businessNumber:message.purchaseOrderNumber,
      validationStatus:'VALID',deliveryStatus:'DELIVERED',acknowledgmentStatus:'NOT_REQUIRED',createdAt:new Date().toISOString()},message:clone(message)});
    return id;
  }
  function factory(secret){
    if(secret.apiKey!==apiKey)throw new ValidationError('The EDI network refused this key.');
    return {
      async transaction(id){const d=documents.get(id);if(!d)throw new ValidationError('No such EDI transaction.');if(d.meta.stream!=='test')throw new ValidationError('Choose a transaction from the test stream.');return clone(d.meta);},
      async message(id){const d=documents.get(id);if(!d)throw new ValidationError('No such EDI transaction.');return clone(d.message);},
      async inbox(con,start,end){
        const from=Date.parse(start),to=Date.parse(end);
        const items=[...documents.values()].map(d=>d.meta).filter(m=>m.direction==='in'&&m.receiverId===con.seller&&(!con.buyer||m.senderId===con.buyer)&&
          Date.parse(m.createdAt)>=from&&Date.parse(m.createdAt)<=to);
        return {items:clone(items),nextCursor:null};
      },
      async send(type,seller,buyer,document){
        const id=randomUUID();
        documents.set(id,{meta:{id,stream:'test',direction:'out',senderId:seller,receiverId:buyer,ediTransactionType:type,businessNumber:document.purchaseOrderNumber||document.orders?.[0]?.purchaseOrderNumber,
          validationStatus:'VALID',deliveryStatus:'DELIVERED',acknowledgmentStatus:'ACCEPTED',createdAt:new Date().toISOString()},message:clone(document)});
        sent.push({id,type,seller,buyer,document:clone(document)});
        if(loseNext){loseNext=false;throw new ValidationError('The Orderful request outcome is unknown. Check the test transaction before sending again.');}
        return {id,status:'ACCEPTED'};
      }
    };
  }
  return {factory,deliver,sent,documents,apiKey,lose(){loseNext=true;}};
}
module.exports={ediNetwork};
