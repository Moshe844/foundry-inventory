'use strict';
(() => {
  const field=document.getElementById('review-token');
  if(!field)return;
  const supplied=new URLSearchParams(location.hash.slice(1)).get('access');
  if(supplied&&supplied.length<=2048)field.value=supplied;
  // The credential stays in the form body, never HTTP URLs or referrers.
  if(location.hash)history.replaceState(null,'',location.pathname);
})();
