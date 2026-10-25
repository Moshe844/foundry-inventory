'use strict';
document.querySelectorAll('[data-production-repeat]').forEach(group=>{
 group.querySelector('[data-add-row]')?.addEventListener('click',()=>{const row=group.querySelector('[data-production-row]').cloneNode(true);row.querySelectorAll('input').forEach(input=>{input.value=input.defaultValue;});group.querySelector('[data-production-rows]').append(row);bind(row);});
});
function bind(row){
 const search=row.querySelector('[data-production-search]'),select=row.querySelector('[data-production-select]'),status=row.querySelector('[data-search-status]');if(!search||!select)return;
 let timer,controller,version=0;search.addEventListener('input',()=>{clearTimeout(timer);controller?.abort();const current=++version;timer=setTimeout(async()=>{controller=new AbortController();status.textContent='Searching…';try{const response=await fetch('/manufacturing/products?q='+encodeURIComponent(search.value),{signal:controller.signal,headers:{Accept:'application/json'}});if(!response.ok)throw Error();const {products}=await response.json();if(current!==version)return;const previous=select.selectedOptions[0];select.replaceChildren(new Option('Choose a product',''));products.forEach(p=>select.add(new Option(p.label,p.id,false,p.id===previous?.value)));if(previous?.value&&!products.some(p=>p.id===previous.value))select.add(previous);status.textContent=products.length+' matches. Search to refine.';}catch(error){if(error.name!=='AbortError')status.textContent='Could not search. Please try again.';}},200);});
}
document.querySelectorAll('[data-production-picker]').forEach(bind);
