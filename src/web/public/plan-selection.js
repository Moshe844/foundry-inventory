'use strict';
// A subscription or selection may have changed on the page left by Back.
// Refresh the server-owned state when restoring pricing from the back cache.
window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload();});
