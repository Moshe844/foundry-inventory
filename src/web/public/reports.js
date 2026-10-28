'use strict';

document.addEventListener('DOMContentLoaded',()=>{
  const describe=document.querySelector('[data-report-describe]');
  describe?.addEventListener('submit',async event=>{event.preventDefault();const button=describe.querySelector('button[type=submit]'),status=describe.querySelector('[data-report-build-status]');button.disabled=true;status.hidden=false;status.textContent='Building your report from your business records…';try{const response=await fetch(describe.action,{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(describe))});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.message||result.error?.message||'This report could not be built. Your description is kept here.');status.textContent='Ready: '+result.title;location.assign(result.url);}catch(error){status.textContent=error.message;status.setAttribute('role','alert');button.disabled=false;describe.querySelector('textarea').focus();}});
  const builder=document.querySelector('[data-report-builder]');
  // A report control named dataset masks HTMLFormElement.dataset. Read the UI marker directly.
  const activeReport=builder?.getAttribute('data-active-report')==='true';
  if(activeReport&&!location.hash&&!window.StockChiefNavigation?.wasRestored())requestAnimationFrame(()=>{document.getElementById('report-manual')?.scrollIntoView({block:'start'});});
  const stepPanels=[...document.querySelectorAll('[data-report-step-panel]')],stepLinks=[...document.querySelectorAll('[data-report-step-link]')];
  if(builder&&stepPanels.length){
    const editor=document.querySelector('[data-report-editor]'),startsWithEditor=activeReport||new URL(location.href).searchParams.has('dataset');if(editor)editor.hidden=!startsWithEditor&&!location.hash;
    const keys=stepPanels.map(panel=>panel.dataset.reportStepPanel),nav=document.querySelector('.report-section-nav'),controls=document.querySelector('[data-report-step-controls]'),previous=controls.querySelector('[data-report-step-previous]'),next=controls.querySelector('[data-report-step-next]'),state=controls.querySelector('[data-report-step-status]');let current=0;controls.hidden=false;
    const keyFromHash=()=>stepLinks.find(link=>link.getAttribute('href')===location.hash)?.dataset.reportStepLink||'source';
    function activate(key,focus=false){current=Math.max(0,keys.indexOf(key));stepPanels.forEach((panel,index)=>{panel.hidden=index!==current;});stepLinks.forEach(link=>{if(link.dataset.reportStepLink===keys[current])link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');});previous.disabled=current===0;next.disabled=current===keys.length-1;state.textContent='Section '+(current+1)+' of '+keys.length;if(focus){nav.scrollIntoView({block:'start'});const target=stepPanels[current].querySelector('h2,input:not([type=hidden]),select');if(target){if(target.tagName==='H2')target.tabIndex=-1;target.focus({preventScroll:true});}}}
    function move(key){if(editor)editor.hidden=false;const link=stepLinks.find(link=>link.dataset.reportStepLink===key);if(link&&location.hash!==link.hash)history.pushState(history.state,'',link.hash);activate(key,true);}
    stepLinks.forEach(link=>link.addEventListener('click',event=>{event.preventDefault();move(link.dataset.reportStepLink);}));previous.addEventListener('click',()=>move(keys[current-1]));next.addEventListener('click',()=>move(keys[current+1]));
    const sync=()=>{if(editor)editor.hidden=!startsWithEditor&&!location.hash;activate(keyFromHash());};addEventListener('popstate',sync);addEventListener('hashchange',sync);builder.addEventListener('invalid',event=>{const panel=event.target.closest('[data-report-step-panel]');if(panel)activate(panel.dataset.reportStepPanel);},true);activate(keyFromHash());
  }
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
      previewStatus.textContent=data.returned+(data.hasMore?'+':'')+(data.returned===1?' row shown · ':' rows shown · ')+(data.elapsedMs/1000).toFixed(1)+' s';
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
    const schedule=()=>{clearTimeout(timer);revision++;controller?.abort();previewStatus.textContent='Updating preview…';timer=setTimeout(load,300);};
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
