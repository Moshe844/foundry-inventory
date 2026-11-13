'use strict';

// A scripted 3PL for tests only (job 186): one more adapter of the shape in
// src/connections/third-party-logistics.js. Production never registers it; a
// test hands it in, then ships, loses answers and reports stock as it likes.
const {ValidationError}=require('../../src/domain/errors');

function fake3pl(key='acme-3pl',{apiKey='acme-test-key',account='ACME-1'}={}){
  const orders=new Map(),stock=new Map();let created=0,loseNext=false;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const adapter={label:'Acme 3PL',connectorKey:'agent-3pl:'+key,account:config=>String(config.account),
    // Acme's own request shape: the fingerprint is taken over it.
    payload:o=>({ref:o.reference,number:o.number,shipTo:o.recipient,items:o.lines.map(l=>({sku:l.sku,qty:l.quantity}))}),
    client(secret,config){
      return {
        async verify(){if(secret.apiKey!==apiKey||config.account!==account)throw new ValidationError('Acme refused this key or account.');},
        async submit(payload,beforeCreate){
          const found=orders.get(payload.ref);if(found)return clone(found);
          if(beforeCreate)await beforeCreate();
          created++;const placed={id:'A'+(1000+created),status:'Received',shipments:[],request:clone(payload)};orders.set(payload.ref,placed);
          if(loseNext){loseNext=false;const error=new ValidationError('Acme did not respond.');error.retryable=true;throw error;}
          return clone(placed);
        },
        async order(id,reference){const o=orders.get(reference);if(!o||o.id!==id)throw new ValidationError('Acme order does not match its reference.');return clone(o);},
        async stock(ref,sku){const s=stock.get(ref);if(!s||s.sku!==sku)throw new ValidationError('Acme inventory does not match this SKU.');return {inventoryRef:ref,onHand:s.onHand,available:s.available};}
      };
    }};
  // Acme ships part or all of an order.
  function ship(reference,{id,lines,carrier='UPS',tracking}){
    const o=orders.get(reference);o.status='Shipped';
    o.shipments.push({id,status:'Shipped',shipped:true,carrier,tracking:tracking||null,shippedAt:new Date().toISOString(),lines});
  }
  return {key,adapter,apiKey,account,orders,stock,ship,get created(){return created;},lose(){loseNext=true;}};
}
module.exports={fake3pl};
