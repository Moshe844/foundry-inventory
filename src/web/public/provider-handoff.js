'use strict';
const handoff=document.querySelector('[data-provider-handoff]');
if(handoff){try{if(window.top!==window.self)window.top.location.href=handoff.href;else window.location.replace(handoff.href);}catch{/* The visible link is the fallback when the browser requires a click. */}}
