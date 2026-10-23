'use strict';
for(const form of document.querySelectorAll('[data-package-editor]')){
 const holder=form.querySelector('[data-package-rows]'),add=form.querySelector('[data-add-package]'),count=form.querySelector('[data-package-count]');
 const update=()=>{const rows=[...holder.querySelectorAll('[data-package-row]')];rows.forEach((row,index)=>{row.querySelector('[data-package-number]').textContent=String(index+1);for(const input of row.querySelectorAll('[data-package-field]'))input.name='packages['+index+']['+input.dataset.packageField+']';row.querySelector('[data-remove-package]').disabled=rows.length===1;});count.textContent=rows.length+' '+(rows.length===1?'package':'packages');add.disabled=rows.length>=100;};
 add.addEventListener('click',()=>{if(holder.children.length>=100)return;const row=holder.querySelector('[data-package-row]').cloneNode(true);for(const input of row.querySelectorAll('input'))input.value='';holder.append(row);update();row.querySelector('input').focus();});
 holder.addEventListener('click',event=>{if(!event.target.closest('[data-remove-package]')||holder.children.length<=1)return;event.target.closest('[data-package-row]').remove();update();});update();
}
