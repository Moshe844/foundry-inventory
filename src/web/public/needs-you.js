'use strict';
(()=>{let formatter;try{formatter=window.StockChiefFormat.create(document.documentElement.dataset.timeZone);const zone=formatter.timeZone;for(const label of document.querySelectorAll('[data-inbox-time-zone]'))label.textContent=zone;}catch{return;}
 for(const time of document.querySelectorAll('time[data-inbox-instant]')){const date=new Date(time.dateTime);if(!Number.isNaN(date.getTime())){time.textContent=formatter.dateTime(date);time.title=date.toISOString();}}
})();
