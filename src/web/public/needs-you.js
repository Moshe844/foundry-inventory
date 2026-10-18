'use strict';
(()=>{let formatter;try{formatter=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});const zone=formatter.resolvedOptions().timeZone;for(const label of document.querySelectorAll('[data-inbox-time-zone]'))label.textContent=zone;}catch{return;}
 for(const time of document.querySelectorAll('time[data-inbox-instant]')){const date=new Date(time.dateTime);if(!Number.isNaN(date.getTime())){time.textContent=formatter.format(date);time.title=date.toISOString();}}
})();
