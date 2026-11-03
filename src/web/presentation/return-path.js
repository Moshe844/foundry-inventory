'use strict';
// Where to send somebody back to after a detour. Only an order or a parcel in
// this app, never an address supplied from outside.
function safeReturn(value){const text=String(value||'');return /^\/(?:orders|fulfilment)\/[\w-]+(?:#[\w-]+)?$/.test(text)?text:null;}
module.exports={safeReturn};
