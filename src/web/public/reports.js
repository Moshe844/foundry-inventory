'use strict';

document.addEventListener('DOMContentLoaded',()=>{
  const builder=document.querySelector('[data-report-builder]');
  const previewStatus=document.querySelector('[data-report-preview-status]');
  const previewTable=document.querySelector('[data-report-preview-table]');
  const fieldSearch=document.querySelector('[data-report-field-search]');
  if(fieldSearch)fieldSearch.addEventListener('input',()=>{
    const needle=fieldSearch.value.trim().toLocaleLowerCase();
    for(const area of document.querySelectorAll('.report-field-area')){
      let visible=0;
      for(const label of area.querySelectorAll('label')){
        label.hidden=Boolean(needle)&&!label.textContent.toLocaleLowerCase().includes(needle);
        if(!label.hidden)visible++;
      }
      area.hidden=visible===0;
    }
  });
  if(builder&&previewStatus&&previewTable){
    let timer,controller,revision=0;
    const draw=(data)=>{
      previewTable.replaceChildren();
      if(!data.rows.length){previewStatus.textContent='No records match these choices.';return;}
      previewStatus.textContent=data.returned+' rows shown'+(data.hasMore?' · more available':'');
      const table=document.createElement('table'),head=table.createTHead().insertRow();
      for(const key of data.columns){const cell=document.createElement('th');cell.scope='col';cell.textContent=data.labels[key]||key;head.append(cell);}
      const body=table.createTBody();
      for(const row of data.rows){const tr=body.insertRow();for(const key of data.columns){const td=tr.insertCell();td.textContent=String(row[key]??'');}}
      previewTable.append(table);
    };
    const load=async()=>{
      const current=++revision;controller?.abort();controller=new AbortController();
      previewStatus.textContent='Updating preview…';
      try{
        const response=await fetch('/reports/preview',{method:'POST',body:new URLSearchParams(new FormData(builder)),
          headers:{Accept:'application/json'},credentials:'same-origin',signal:controller.signal});
        const data=await response.json();if(current!==revision)return;
        if(!data.ok){previewTable.replaceChildren();previewStatus.textContent=data.message||'Choose valid report fields.';return;}
        draw(data);
      }catch(error){if(error.name!=='AbortError'&&current===revision){previewTable.replaceChildren();previewStatus.textContent='Preview unavailable. Try again or open the full report.';}}
    };
    const schedule=()=>{clearTimeout(timer);timer=setTimeout(load,300);};
    builder.addEventListener('input',schedule);builder.addEventListener('change',schedule);schedule();
  }
  for(const row of document.querySelectorAll('[data-report-measure]')){
    const source=row.querySelector('[data-report-source]');
    const update=()=>{for(const select of row.querySelectorAll('[data-report-measure-field],[data-report-filter-field]')){
      for(const option of select.querySelectorAll('option[data-source]')){
        option.hidden=option.dataset.source!==source.value;
        option.disabled=option.dataset.source!==source.value;
      }
      if(select.selectedOptions[0]?.disabled)select.value='';
    }};
    source?.addEventListener('change',update);update();
  }
  const rows=[...document.querySelectorAll('[data-report-filter]')];
  const add=document.querySelector('[data-report-add-filter]');
  if(!add||!rows.length)return;
  const update=()=>{add.hidden=!rows.some((row)=>row.hidden);};
  add.addEventListener('click',()=>{
    const next=rows.find((row)=>row.hidden);
    if(!next)return;
    next.hidden=false;
    next.querySelector('select')?.focus();
    update();
  });
  update();
});
