'use strict';
(()=>{const node=document.querySelector('[data-shipping-batch]');if(!node)return;const original={complete:Number(node.dataset.complete),needsAttention:Number(node.dataset.needsAttention),total:Number(node.dataset.total)};if(original.complete+original.needsAttention>=original.total)return;
 let stopped=false,controller;window.addEventListener('pagehide',()=>{stopped=true;controller?.abort();},{once:true});
 async function update(){if(stopped)return;try{controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);let response;try{response=await fetch(node.dataset.statusUrl,{credentials:'same-origin',cache:'no-store',signal:controller.signal});}finally{clearTimeout(timer);}if(response.status===401||response.status===403){stopped=true;return;}if(response.ok){const current=await response.json();if(current.complete!==original.complete||current.needsAttention!==original.needsAttention||current.total!==original.total){location.reload();return;}}}catch{}if(!stopped)setTimeout(update,5000);}
 setTimeout(update,3000);
})();
