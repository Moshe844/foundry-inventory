'use strict';

document.addEventListener('DOMContentLoaded',()=>{
  const builder=document.querySelector('[data-report-builder]');
  const previewStatus=document.querySelector('[data-report-preview-status]');
  const previewTable=document.querySelector('[data-report-preview-table]');
  const fieldSearch=document.querySelector('[data-report-field-search]');
  const columnOrder=document.querySelector('[data-report-column-order]');
  if(builder&&columnOrder){
    const list=columnOrder.querySelector('[data-report-column-list]');
    const choices=[...builder.querySelectorAll('[data-report-column-choice]')];
    const byField=new Map(choices.map(choice=>[choice.value,choice]));
    const parse=(value,fallback)=>{try{return JSON.parse(value)||fallback;}catch{return fallback;}};
    const savedOrder=parse(columnOrder.dataset.initialColumns,[]);
    const labels=parse(columnOrder.dataset.initialLabels,{});
    let order=[...new Set([...savedOrder,...choices.filter(choice=>choice.checked).map(choice=>choice.value)])]
      .filter(field=>byField.get(field)?.checked);
    choices.forEach(choice=>choice.removeAttribute('name'));
    const changed=()=>builder.dispatchEvent(new Event('change',{bubbles:true}));
    const move=(field,target)=>{const from=order.indexOf(field);if(from<0||target<0||target>=order.length||from===target)return;
      order.splice(from,1);order.splice(target,0,field);render();changed();};
    function render(){
      list.replaceChildren();
      for(const [index,field] of order.entries()){
        const choice=byField.get(field),row=document.createElement('li');row.draggable=true;row.dataset.field=field;
        const hidden=document.createElement('input');hidden.type='hidden';hidden.name='columns';hidden.value=field;row.append(hidden);
        const title=document.createElement('span');title.textContent=choice.dataset.reportColumnLabel||field;row.append(title);
        const rename=document.createElement('input');rename.type='text';rename.name='columnLabels['+field+']';rename.maxLength=60;
        rename.placeholder='Heading';rename.value=labels[field]||'';rename.setAttribute('aria-label','Rename '+title.textContent);
        rename.addEventListener('input',()=>{labels[field]=rename.value;});row.append(rename);
        for(const [direction,symbol] of [[-1,'↑'],[1,'↓']]){
          const button=document.createElement('button');button.type='button';button.textContent=symbol;
          button.setAttribute('aria-label','Move '+title.textContent+(direction<0?' up':' down'));
          button.disabled=direction<0?index===0:index===order.length-1;
          button.addEventListener('click',()=>move(field,index+direction));row.append(button);
        }
        row.addEventListener('dragstart',event=>event.dataTransfer.setData('text/plain',field));
        row.addEventListener('dragover',event=>event.preventDefault());
        row.addEventListener('drop',event=>{event.preventDefault();move(event.dataTransfer.getData('text/plain'),order.indexOf(field));});
        list.append(row);
      }
    }
    choices.forEach(choice=>choice.addEventListener('change',()=>{
      if(choice.checked&&!order.includes(choice.value))order.push(choice.value);
      if(!choice.checked)order=order.filter(field=>field!==choice.value);
      render();
    }));
    render();
  }
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
      previewStatus.textContent=data.returned+(data.hasMore?'+':'')+' rows shown · '+(data.elapsedMs/1000).toFixed(1)+' s';
      const table=document.createElement('table'),head=table.createTHead().insertRow();
      for(const key of data.columns){const cell=document.createElement('th');cell.scope='col';cell.textContent=data.labels[key]||key;head.append(cell);}
      const body=table.createTBody();
      for(const [index,row] of data.rows.entries()){
        const tr=body.insertRow();
        for(const key of data.columns){
          const td=tr.insertCell(),value=String(row[key]??'');
          if(data.groups?.length&&key===data.columns.at(-1)){
            const button=document.createElement('button');button.type='button';button.className='report-source-link';
            button.textContent=value;button.setAttribute('aria-label','Show records behind '+value);
            button.addEventListener('click',()=>{
              const form=document.createElement('form');form.method='post';form.action='/reports/drilldown';
              const values={_csrf:builder.querySelector('[name="_csrf"]')?.value||'',
                definition:JSON.stringify(data.definition),groupValues:JSON.stringify(data.groupValues[index])};
              for(const [name,text] of Object.entries(values)){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=text;form.append(input);}
              document.body.append(form);form.submit();
            });td.append(button);
          }else if(data.links?.[index]?.startsWith('/')&&!data.links[index].startsWith('//')){
            const link=document.createElement('a');link.href=data.links[index];link.textContent=value;td.append(link);
          }else td.textContent=value;
        }
      }
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
