/* Display actual instants in the browser's timezone on public and app pages. */
(function(){'use strict';
 let format;try{format=window.StockChiefFormat.create(document.documentElement.dataset.timeZone);}catch{return;}
 function update(){document.querySelectorAll('time[data-local-time]').forEach(node=>{const value=node.getAttribute('datetime');if(value&&Number.isFinite(Date.parse(value))){const text=format.dateTime(value);if(node.textContent!==text)node.textContent=text;node.title=new Date(value).toISOString();}});}
 update();document.addEventListener('visibilitychange',update);document.addEventListener('stockchief:content-updated',update);
 if(typeof MutationObserver==='function')new MutationObserver(records=>{if(records.some(r=>r.type==='attributes'||[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('time[data-local-time]')||n.querySelector?.('time[data-local-time]')))))update();}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['datetime']});
})();
