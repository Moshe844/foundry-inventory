'use strict';
// Keep exact SKU IDs in ordinary form controls; search only fetches choices.
window.StockChiefSkuPicker={init(root=document){
 for(const select of root.querySelectorAll('select[data-async-sku]')){
  if(select.previousElementSibling?.matches('[data-sku-query]'))continue;
  if(!select.hasAttribute('aria-label'))select.setAttribute('aria-label',select.closest('label')?.firstChild?.textContent.trim()||'Product');
  const query=document.createElement('input'),status=document.createElement('small');
  query.className=select.className;query.type='search';query.placeholder='Search SKU, barcode or product';query.autocomplete='off';
  query.dataset.skuQuery='';query.setAttribute('aria-label','Search products');
  status.setAttribute('role','status');status.className='field-help';
  select.before(query);select.after(status);
  let timer,request,version=0;
  async function search(){
   const current=++version;if(request)request.abort();request=new AbortController();
   const url=new URL(select.dataset.endpoint,location.origin);url.searchParams.set('q',query.value.trim());
   status.textContent='Searching…';
   try{
    const response=await fetch(url,{credentials:'same-origin',headers:{accept:'application/json'},signal:request.signal});
    if(!response.ok)throw Error('search');const data=await response.json();if(current!==version)return;
    const selected=[...select.options].filter(option=>option.selected&&option.value),ids=new Set(selected.map(option=>option.value));
    select.replaceChildren();if(!select.multiple)select.add(new Option('Choose a product','',false,!selected.length));
    for(const option of selected)select.add(option);
    for(const product of data.products){if(ids.has(product.id))continue;
     const option=new Option((product.display_name||product.item_name||product.name)+' · '+product.code,product.id);
     if(product.purchaseCost!=null)option.dataset.cost=product.purchaseCost;
     if(product.leadDays!=null)option.dataset.lead=product.leadDays;
     select.add(option);
    }
    status.textContent=data.products.length?'Choose a result. Search more specifically if needed.':'No matching products.';
   }catch(error){if(error.name!=='AbortError'&&current===version)status.textContent='Could not load products. Try searching again.';}
  }
  query.addEventListener('input',()=>{++version;if(request)request.abort();clearTimeout(timer);timer=setTimeout(search,250);});
  query.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();clearTimeout(timer);search();}});
  query.addEventListener('focus',()=>{if(!query.value&&!select.options.length)search();},{once:true});
 }
}};
window.StockChiefSkuPicker.init();
