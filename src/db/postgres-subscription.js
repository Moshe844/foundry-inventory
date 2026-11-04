'use strict';
const {Client}=require('pg');
// LISTEN owns a connection outside the query pool, including max:1 pools.
// A reconnect discards cache state because notifications are not durable.
function subscribe(options,channel,notify,{onState=()=>{},onConnect=async()=>{}}={}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(channel)||typeof notify!=='function')throw new TypeError('Invalid PostgreSQL subscription.');
 let stopped=false,client=null,timer=null,attempt=null,connected=false,generation=0;
 const connect=()=>{
  if(stopped||attempt)return attempt;
  attempt=(async()=>{
   const current=new Client({...options,application_name:(options.application_name||'stockchief')+':listen'});client=current;let failed=false;
   const lost=()=>{if(failed)return;failed=true;if(client===current){connected=false;onState(false);client=null;}current.end().catch(()=>{});if(!stopped){timer=setTimeout(connect,1000);timer.unref();}};
   current.on('error',lost);current.on('end',lost);
   current.on('notification',message=>{if(!stopped&&connected&&message.channel===channel)notify(message);});
   try{await current.connect();await current.query(`LISTEN "${channel}"`);await onConnect(current);if(!stopped&&!failed){connected=true;generation++;onState(true);}}
   catch{lost();}
  })().finally(()=>{attempt=null;});return attempt;
 };
 const ready=connect();
 return {ready,get connected(){return connected;},get generation(){return generation;},async stop(){stopped=true;connected=false;clearTimeout(timer);const current=client;client=null;if(current)await current.end().catch(()=>{});if(attempt)await attempt;}};
}
module.exports={subscribe};
