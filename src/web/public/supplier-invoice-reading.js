'use strict';
for(const form of document.querySelectorAll('[data-invoice-reading]')){
 const lines=form.querySelector('[data-reading-lines]');
 form.querySelector('[data-add-reading-line]').addEventListener('click',()=>{const copy=lines.querySelector('[data-reading-line]').cloneNode(true);for(const input of copy.querySelectorAll('input,textarea'))input.value='';for(const select of copy.querySelectorAll('select'))select.selectedIndex=0;lines.append(copy);copy.querySelector('input').focus();});
 lines.addEventListener('click',event=>{if(event.target.closest('[data-remove-reading-line]')&&lines.querySelectorAll('[data-reading-line]').length>1)event.target.closest('[data-reading-line]').remove();});
}

document.querySelectorAll('[data-invoice-reading]').forEach(form=>{const kind=form.querySelector('[name=documentType]');if(!kind)return;const update=()=>{for(const input of form.querySelectorAll('[name=purchaseOrder],[name=lineCode],[name=lineQuantity],[name=linePrice],[name=lineTotal]'))input.required=kind.value!=='credit';};kind.addEventListener('change',update);update();});
