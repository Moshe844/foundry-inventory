/* The same calendar/instant presentation contract runs in Node and the browser. */
(function(root,factory){'use strict';if(typeof module==='object'&&module.exports)module.exports=factory();else root.StockChiefFormat=factory();})(typeof globalThis==='object'?globalThis:this,function(){'use strict';
 const cache=new Map();
 function parsed(value){if(value===null||value===undefined||value==='')return null;const date=value instanceof Date?value:new Date(value);return Number.isFinite(date.getTime())?date:null;}
 function create(zone){const timeZone=zone||new Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';if(cache.has(timeZone))return cache.get(timeZone);
  const day=new Intl.DateTimeFormat('en-US',{timeZone,month:'short',day:'numeric',year:'numeric'}),calendar=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}),at=new Intl.DateTimeFormat('en-US',{timeZone,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  const format=Object.freeze({timeZone,date(value){if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)){const d=parsed(value+'T00:00:00Z');return d&&d.toISOString().slice(0,10)===value?calendar.format(d):'';}const d=parsed(value);return d?day.format(d):'';},dateTime(value){const d=parsed(value);return d?at.format(d):'';}});
  if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(timeZone,format);return format;
 }
 return {create};
});
