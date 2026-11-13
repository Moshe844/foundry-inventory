'use strict';

// Job 185: the seam between StockChief and the EDI network that carries a
// retailer's documents. Retail EDI (postgres-orderful-test.js) never speaks a
// network's own API; it asks a provider for these four things:
//
//   transaction(id) -> {id, stream, direction:'in'|'out', senderId, receiverId,
//                       ediTransactionType, businessNumber, validationStatus,
//                       deliveryStatus, acknowledgmentStatus, createdAt}
//   message(id)     -> the document itself (JSON), as the network holds it
//   inbox({seller}, start, end, cursor)
//                   -> {items:[transaction], nextCursor}: documents sent to
//                      this business between two instants
//   send(type, seller, buyer, document)
//                   -> {id, status:'ACCEPTED'|'FAILED'}; a lost answer throws,
//                      and the saved request is reconciled, never sent twice
//
// Types are X12 names: 850_PURCHASE_ORDER and 860_PURCHASE_ORDER_CHANGE come
// in; 855_PURCHASE_ORDER_ACKNOWLEDGMENT, 856_SHIP_NOTICE_MANIFEST and
// 810_INVOICE go out. Orderful's test stream is the one built in. Tests hand
// in a scripted retailer through register(); production never falls back to it.

const {ValidationError}=require('../domain/errors');
const REQUIRED=['transaction','message','inbox','send'];
const providers=new Map();

function register(name,factory){
  const key=String(name||'').toLowerCase();
  if(!key||typeof factory!=='function')throw new TypeError('An EDI provider needs a name and a client factory.');
  providers.set(key,factory);
  return ()=>providers.delete(key);
}
function has(name){return providers.has(String(name||'').toLowerCase());}
function client(name,secret,transport){
  const factory=providers.get(String(name||'orderful').toLowerCase());
  if(!factory)throw new ValidationError('This EDI network is not available. Reconnect Retail EDI.');
  const made=factory(secret||{},transport);
  const missing=REQUIRED.filter(m=>typeof made?.[m]!=='function');
  if(missing.length)throw new TypeError('EDI provider "'+name+'" is missing: '+missing.join(', ')+'.');
  return made;
}

register('orderful',(secret,transport)=>require('./orderful-test-api').client(secret.apiKey,transport));

module.exports={register,has,client,REQUIRED};
