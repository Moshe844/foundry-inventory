'use strict';
// Each location's edit form draws its address boxes when it opens, so a business
// with thousands of bins does not send thousands of state lists with this page.
(function(){
 var count=0;
 function boxes(dialog){var template=document.getElementById('location-address-template'),slot=dialog&&dialog.querySelector('[data-address-slot]');
  if(!template||!slot||slot.firstElementChild||!window.stockChiefAddressFields)return;
  var clone=template.content.cloneNode(true),box=clone.querySelector('[data-address-box]');count++;
  box.dataset.addressTarget=slot.dataset.addressSlot;
  var input=box.querySelector('[data-part="city"]'),list=box.querySelector('datalist');if(input&&list){list.id='edit-addr-cities-'+count;input.setAttribute('list',list.id);}
  clone.querySelectorAll('script,link').forEach(function(node){node.remove();});
  slot.appendChild(clone);window.stockChiefAddressFields.init(box);}
 document.addEventListener('click',function(event){var opener=event.target.closest('[data-modal-open^="modal-location-"]');if(opener)boxes(document.getElementById(opener.getAttribute('data-modal-open')));},true);
 var chosen=document.querySelector('dialog[data-open-on-load]');
 if(chosen){boxes(chosen);if(!chosen.open)chosen.showModal();}
 if(location.hash==='#add-location'){var dialog=document.getElementById('modal-location');if(dialog&&!dialog.open)dialog.showModal();}
})();
