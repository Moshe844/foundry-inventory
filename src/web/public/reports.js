'use strict';

// A word for each comparison, per kind of field. The stored operators stay as the server knows them.
const REPORT_OPERATORS={
  text:[['contains','contains'],['equals','is exactly'],['is_not','is not'],['not_empty','has a value'],['is_empty','is empty']],
  choice:[['equals','is'],['is_not','is not'],['not_empty','has a value'],['is_empty','is empty']],
  number:[['at_least','is at least'],['at_most','is at most'],['greater_than','is more than'],['less_than','is less than'],['equals','is exactly'],['is_not','is not'],['not_empty','has a value'],['is_empty','is empty']],
  date:[['relative','is in'],['after','is on or after'],['before','is on or before'],['equals','is on'],['greater_than','is after'],['less_than','is before'],['not_empty','has a value'],['is_empty','is empty']],
};
const REPORT_NO_VALUE=new Set(['is_null','is_empty','not_empty']);
const REPORT_RESULT={count:'count',count_distinct:'distinct_count',sum:'total',average:'average',minimum:'minimum',maximum:'maximum',ratio:'ratio'};
const REPORT_MONTH=new Intl.DateTimeFormat(undefined,{month:'short',year:'numeric',timeZone:'UTC'});
const REPORT_DAY=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});

function reportDateText(value,grain){
  const text=String(value??'');if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return text;
  const date=new Date(text+'T12:00:00Z');
  if(grain==='year')return String(date.getUTCFullYear());
  if(grain==='quarter')return 'Q'+(Math.floor(date.getUTCMonth()/3)+1)+' '+date.getUTCFullYear();
  if(grain==='month')return REPORT_MONTH.format(date);
  if(grain==='week')return 'Week of '+REPORT_DAY.format(date);
  return REPORT_DAY.format(date);
}
function reportElement(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}

function setupReportBuilder(builder){
  const schema=JSON.parse(builder.getAttribute('data-report-schema')||'{}'),fields=schema.fields||{};
  const typeOf=field=>fields[field]?.type;
  const labelOf=field=>fields[field]?.label||schema.metrics?.[field]?.label||field;
  const one=selector=>builder.querySelector(selector),all=selector=>[...builder.querySelectorAll(selector)];
  const fractionDigits=(()=>{try{return new Intl.NumberFormat('en-US',{style:'currency',currency:schema.currency||'USD'}).resolvedOptions().maximumFractionDigits;}catch{return 2;}})();
  const minorPerUnit=10**fractionDigits;

  /* Opening the editor, and moving to a section of it */
  const editor=document.querySelector('[data-report-editor]'),startsOpen=!editor.hasAttribute('data-report-starts-closed');
  const start=document.querySelector('[data-report-start]'),describeBox=document.getElementById('report-description');
  const showEditor=open=>{
    editor.hidden=!open;start?.classList.toggle('is-compact',open);
    if(describeBox)describeBox.rows=open?1:2;
    for(const node of document.querySelectorAll('[data-report-landing],[data-report-landing-part],[data-report-lede]'))node.hidden=open;
    const actions=document.querySelector('[data-report-head-actions]');if(actions)actions.hidden=!open;
  };
  const stepLinks=[...document.querySelectorAll('[data-report-step-link]')];
  const openSection=key=>{
    const panel=builder.querySelector('[data-report-step-panel="'+key+'"]');
    if(!panel)return;
    if(panel.tagName==='DETAILS')panel.open=true;
    if(key==='columns')panel.querySelector('[data-report-picker]').open=true;
    panel.scrollIntoView({block:'start'});
    panel.classList.remove('is-arrived');void panel.offsetWidth;panel.classList.add('is-arrived');
    stepLinks.forEach(link=>{if(link.dataset.reportStepLink===key)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');});
  };
  stepLinks.forEach(link=>link.addEventListener('click',event=>{
    event.preventDefault();showEditor(true);
    if(location.hash!==link.hash)history.pushState(history.state,'',link.hash);
    openSection(link.dataset.reportStepLink);
  }));
  const syncFromLocation=()=>{showEditor(startsOpen||Boolean(location.hash));const link=stepLinks.find(row=>row.hash===location.hash&&row.dataset.reportStepLink!=='source');if(link)openSection(link.dataset.reportStepLink);};
  addEventListener('popstate',syncFromLocation);addEventListener('hashchange',syncFromLocation);
  showEditor(startsOpen||Boolean(location.hash));
  builder.addEventListener('invalid',event=>{const panel=event.target.closest('details');if(panel)panel.open=true;},true);

  /* The three shapes a report can take */
  const modes=all('[name=reportMode]'),modeNow=()=>modes.find(radio=>radio.checked)?.value||'list';
  const summaryFlag=one('[name=summary]'),groupSelects=all('[name=groups]'),groupRows=all('[data-report-group-row]');
  const grain=one('[name=dateGrain]'),grainRow=one('[data-report-grain]'),aggregate=one('[name=aggregate]'),measure=one('[name=measure]'),measureRow=one('[data-report-measure-row]');
  const sort=one('[name=sort]'),direction=one('[name=direction]'),charts=all('[name=chart]'),chartNow=()=>charts.find(radio=>radio.checked)?.value||'table';
  const chooseChart=value=>{const radio=charts.find(row=>row.value===value);if(radio)radio.checked=true;};
  const groupsNow=()=>groupSelects.filter(select=>select.value&&!select.disabled).map(select=>select.value);
  const measureChoices=Object.fromEntries([...measure.options].filter(option=>option.value).map(option=>[option.value,option.textContent]));
  const numericFields=Object.keys(fields).filter(field=>['number','money_minor'].includes(typeOf(field)));
  for(const option of [...aggregate.options]){
    if(option.value==='ratio'&&!Object.keys(schema.metrics||{}).length)option.remove();
    if(['sum','average','minimum','maximum'].includes(option.value)&&!numericFields.length)option.remove();
  }
  const syncMeasure=()=>{
    const kind=aggregate.value,keep=measure.value;
    const choices=kind==='count'?[]:kind==='ratio'?Object.keys(schema.metrics):kind==='count_distinct'?Object.keys(fields):numericFields;
    measure.replaceChildren(...choices.map(field=>new Option(measureChoices[field]||labelOf(field),field)));
    measure.value=choices.includes(keep)?keep:(choices[0]||'');
    measureRow.hidden=kind==='count';measure.disabled=kind==='count'||modeNow()==='list';
  };
  const resultColumn=()=>REPORT_RESULT[aggregate.value]||'count';
  const metricName=(kind,field,text)=>kind==='count'?'Records':kind==='sum'||kind==='ratio'?text:(kind==='average'?'Average ':kind==='minimum'?'Lowest ':kind==='maximum'?'Highest ':'Different ')+String(text||'').toLowerCase();
  const resultName=()=>metricName(aggregate.value,measure.value,measure.selectedOptions[0]?.textContent||'');
  /* Further numbers beside the first */
  const extraRows=all('[data-report-extra]'),extraAdd=one('[data-report-extra-add]'),chartMeasure=one('[data-report-chart-measure]');
  const extraParts=row=>({kind:row.querySelector('[data-report-extra-aggregate]'),field:row.querySelector('[data-report-extra-measure]'),fieldRow:row.querySelector('[data-report-extra-measure-row]')});
  const choicesFor=kind=>kind==='count'?[]:kind==='ratio'?Object.keys(schema.metrics||{}):kind==='count_distinct'?Object.keys(fields):numericFields;
  const fillExtra=(row,wanted)=>{
    const {kind,field,fieldRow}=extraParts(row),list=choicesFor(kind.value);
    field.replaceChildren(...list.map(key=>new Option(measureChoices[key]||labelOf(key),key)));
    field.value=list.includes(wanted)?wanted:(list[0]||'');fieldRow.hidden=kind.value==='count';field.disabled=kind.value==='count'||row.hidden||modeNow()==='list';kind.disabled=row.hidden||modeNow()==='list';
  };
  const activeExtras=()=>extraRows.filter(row=>!row.hidden).map(row=>{const {kind,field}=extraParts(row);return {kind:kind.value,field:kind.value==='count'?'':field.value};});
  const extraColumn=extra=>(REPORT_RESULT[extra.kind]||'count')+'_'+(extra.field||'records');
  const syncExtraAdd=()=>{if(extraAdd)extraAdd.hidden=!extraRows.some(row=>row.hidden)||!numericFields.length;};
  for(const row of extraRows){
    const {kind,field}=extraParts(row);kind.dataset.was=kind.value;
    for(const option of [...kind.options]){if(option.value==='ratio'&&!Object.keys(schema.metrics||{}).length)option.remove();if(['sum','average','minimum','maximum'].includes(option.value)&&!numericFields.length)option.remove();}
    kind.addEventListener('change',()=>{fillExtra(row,field.value);syncSort();requireMoneyScope();});
    field.addEventListener('change',()=>{syncSort();requireMoneyScope();});
    row.querySelector('[data-report-extra-remove]').addEventListener('click',()=>{row.hidden=true;fillExtra(row,'');if(chartMeasure.value&&!activeExtras().some(extra=>extraColumn(extra)===chartMeasure.value))chartMeasure.value='';syncExtraAdd();syncSort();changed();});
  }
  const unusedMeasure=()=>{const used=new Set([measure.value,...activeExtras().map(extra=>extra.field)]);return numericFields.find(key=>typeOf(key)==='money_minor'&&!used.has(key))||numericFields.find(key=>!used.has(key))||'';};
  const addExtra=(kindValue,fieldValue)=>{
    const row=extraRows.find(item=>item.hidden);if(!row)return;
    row.hidden=false;const {kind}=extraParts(row);kind.value=kindValue||'sum';fillExtra(row,fieldValue||unusedMeasure());syncExtraAdd();syncSort();requireMoneyScope();
  };
  extraAdd?.addEventListener('click',()=>{addExtra();changed();});
  const syncDirectionWords=()=>{
    const type=sort.value===resultColumn()?'number':typeOf(sort.value||groupsNow()[0]);
    const [high,low]=type==='date'?['Newest first','Oldest first']:['number','money_minor'].includes(type)?['Highest first','Lowest first']:['Z to A','A to Z'];
    direction.options[0].textContent=high;direction.options[1].textContent=low;
  };
  const autoSort=()=>{
    const groups=groupsNow();
    if(modeNow()==='groups'){const trend=groups.length===1&&typeOf(groups[0])==='date';sort.value=trend?groups[0]:resultColumn();direction.value=trend?'asc':'desc';}
    else sort.value='';
  };
  const syncSort=()=>{
    const keep=sort.value||sort.getAttribute('data-initial')||'',current=modeNow();sort.removeAttribute('data-initial');
    const options=current==='groups'?[...groupsNow().map(field=>[field,labelOf(field)]),[resultColumn(),resultName()],...activeExtras().map(extra=>[extraColumn(extra),metricName(extra.kind,extra.field,measureChoices[extra.field]||labelOf(extra.field))])]:Object.keys(fields).map(field=>[field,labelOf(field)]);
    if(current!=='groups')options.unshift(['','Default order']);
    sort.replaceChildren(...options.map(([value,label])=>new Option(label,value)));
    sort.disabled=current==='summary';
    if(options.some(([value])=>value===keep))sort.value=keep;else autoSort();
    syncDirectionWords();
  };
  const lineAllowed=()=>{const groups=groupsNow();return groups.length===1&&typeOf(groups[0])==='date';};
  const syncChart=()=>{
    const current=modeNow(),allowed=lineAllowed(),two=groupsNow().length===2,one=groupsNow().length===1;
    const why={line:allowed?'':'A line needs one date group',area:allowed?'':'An area needs one date group',donut:one?'':'A donut needs one group',stacked:two?'':'Stacked needs two groups',pivot:two?'':'A cross-tab needs two groups'};
    for(const radio of charts){const reason=why[radio.value]||'';radio.disabled=current!=='groups'||Boolean(reason);radio.closest('label').classList.toggle('is-off',Boolean(reason));radio.closest('label').title=reason;}
    if(why[chartNow()])chooseChart('bar');
  };
  const syncGroups=()=>{
    groupRows.forEach((row,index)=>{row.hidden=index>0&&!groupSelects[index-1].value;if(row.hidden)groupSelects[index].value='';});
    const dated=modeNow()==='groups'&&groupsNow().some(field=>typeOf(field)==='date');
    grainRow.hidden=!dated;grain.disabled=!dated;
  };
  const columnInputs=()=>all('[data-report-column-list] input');
  const applyMode=()=>{
    const current=modeNow();
    for(const node of document.querySelectorAll('[data-report-when]'))node.hidden=!node.dataset.reportWhen.split(' ').includes(current);
    summaryFlag.checked=current==='summary';
    groupSelects.forEach(select=>{select.disabled=current!=='groups';});
    aggregate.disabled=current==='list';
    columnInputs().forEach(input=>{input.disabled=current!=='list';});
    syncGroups();syncMeasure();extraRows.forEach(row=>fillExtra(row,extraParts(row).field.value||extraParts(row).field.dataset.initial));syncExtraAdd();syncSort();syncChart();syncCompare();
  };
  // The first useful total for a source: its first amount when it has one, otherwise a count.
  const startCalculation=()=>{
    if(aggregate.value!=='count')return;
    const amount=numericFields.find(field=>typeOf(field)==='money_minor'&&!schema.moneyCompleteness?.[field]);
    if(amount&&[...aggregate.options].some(option=>option.value==='sum')){aggregate.value='sum';syncMeasure();measure.value=amount;}
  };
  modes.forEach(radio=>radio.addEventListener('change',()=>{
    if(modeNow()==='groups'&&!groupSelects[0].value){const texts=Object.keys(fields).filter(key=>typeOf(key)==='text'&&key!=='currency'),field=texts.find(key=>/product|customer|supplier|category|location/.test(key))||texts.find(key=>!/number|code|sku|reference|note|description|id$/.test(key))||texts[0]||Object.keys(fields).find(key=>typeOf(key)==='date');if(field&&[...groupSelects[0].options].some(option=>option.value===field))groupSelects[0].value=field;}
    if(modeNow()==='groups'&&lineAllowedAfterEnable())grain.value=grain.value==='exact'?'month':grain.value;
    if(modeNow()!=='list')startCalculation();
    sort.value='';applyMode();autoSort();syncDirectionWords();
    if(modeNow()==='groups')chooseChart(lineAllowed()?'line':'bar');
    syncChart();requireMoneyScope();syncTry();
  }));
  function lineAllowedAfterEnable(){const field=groupSelects[0].value;return field&&typeOf(field)==='date';}
  groupSelects.forEach((select,index)=>select.addEventListener('change',()=>{
    if(typeOf(select.value)==='date'&&grain.value==='exact')grain.value='month';
    syncGroups();syncSort();
    if(index===0||chartNow()==='line'){if(lineAllowed()&&chartNow()==='bar')chooseChart('line');}
    syncChart();
    if(['line','area'].includes(chartNow())){sort.value=groupsNow()[0];direction.value='asc';}else if(chartNow()==='bar'&&sort.value===groupsNow()[0]&&typeOf(sort.value)!=='date'){sort.value=resultColumn();direction.value='desc';}
    syncDirectionWords();requireMoneyScope();
  }));
  aggregate.addEventListener('change',()=>{const wasResult=REPORT_RESULT[aggregate.getAttribute('data-was')||'']===sort.value;syncMeasure();if(wasResult)sort.value='';syncSort();aggregate.setAttribute('data-was',aggregate.value);requireMoneyScope();});
  aggregate.setAttribute('data-was',aggregate.value);
  measure.addEventListener('change',()=>{syncSort();requireMoneyScope();});
  charts.forEach(radio=>radio.addEventListener('change',()=>{if(['line','area'].includes(chartNow())){sort.value=groupsNow()[0];direction.value='asc';syncDirectionWords();}}));
  sort.addEventListener('change',()=>{syncDirectionWords();if(['line','area'].includes(chartNow())&&(sort.value!==groupsNow()[0]||direction.value!=='asc'))chooseChart('bar');});
  direction.addEventListener('change',()=>{if(['line','area'].includes(chartNow())&&direction.value!=='asc')chooseChart('bar');});

  /* Columns */
  const columnOrder=one('[data-report-column-order]'),columnList=columnOrder.querySelector('[data-report-column-list]');
  const choices=all('[data-report-column-choice]'),byField=new Map(choices.map(choice=>[choice.value,choice]));
  const parseJson=(value,fallback)=>{try{return JSON.parse(value)||fallback;}catch{return fallback;}};
  const columnLabels=parseJson(columnOrder.dataset.initialColumnLabels||columnOrder.dataset.initialLabels,{});
  let order=[...new Set([...parseJson(columnOrder.dataset.initialColumns,[]),...choices.filter(choice=>choice.checked).map(choice=>choice.value)])].filter(field=>byField.get(field)?.checked);
  choices.forEach(choice=>choice.removeAttribute('name'));
  const changed=()=>builder.dispatchEvent(new Event('change',{bubbles:true}));
  const moveColumn=(field,target)=>{const from=order.indexOf(field);if(from<0||target<0||target>=order.length||from===target)return;order.splice(from,1);order.splice(target,0,field);renderColumns();changed();};
  function renderColumns(){
    columnList.replaceChildren();
    for(const [index,field] of order.entries()){
      const choice=byField.get(field),name=choice.dataset.reportColumnLabel||field,row=document.createElement('li');row.draggable=true;row.dataset.field=field;
      const hidden=document.createElement('input');hidden.type='hidden';hidden.name='columns';hidden.value=field;row.append(hidden,reportElement('span','report-grip'));
      const rename=document.createElement('input');rename.type='text';rename.name='columnLabels['+field+']';rename.maxLength=60;rename.placeholder=name;rename.value=columnLabels[field]||'';rename.setAttribute('aria-label','Rename '+name);
      rename.addEventListener('input',()=>{columnLabels[field]=rename.value;});row.append(rename);
      for(const [step,symbol,word] of [[-1,'↑','up'],[1,'↓','down']]){
        const button=reportElement('button','report-icon-btn',symbol);button.type='button';button.setAttribute('aria-label','Move '+name+' '+word);button.disabled=step<0?index===0:index===order.length-1;
        button.addEventListener('click',()=>moveColumn(field,index+step));row.append(button);
      }
      const remove=reportElement('button','report-icon-btn','×');remove.type='button';remove.setAttribute('aria-label','Remove '+name);
      remove.addEventListener('click',()=>{choice.checked=false;order=order.filter(item=>item!==field);renderColumns();changed();});row.append(remove);
      row.addEventListener('dragstart',event=>event.dataTransfer.setData('text/plain',field));
      row.addEventListener('dragover',event=>event.preventDefault());
      row.addEventListener('drop',event=>{event.preventDefault();moveColumn(event.dataTransfer.getData('text/plain'),order.indexOf(field));});
      columnList.append(row);
    }
    columnInputs().forEach(input=>{input.disabled=modeNow()!=='list';});
  }
  choices.forEach(choice=>choice.addEventListener('change',()=>{
    if(choice.checked&&!order.includes(choice.value))order.push(choice.value);
    if(!choice.checked)order=order.filter(field=>field!==choice.value);
    renderColumns();
  }));
  const fieldSearch=one('[data-report-field-search]');
  fieldSearch.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
  fieldSearch.addEventListener('input',()=>{
    const needle=fieldSearch.value.trim().toLocaleLowerCase();
    for(const area of builder.querySelectorAll('.report-field-area')){
      let visible=0;
      for(const label of area.querySelectorAll('label')){label.hidden=Boolean(needle)&&!label.textContent.toLocaleLowerCase().includes(needle);if(!label.hidden)visible++;}
      area.hidden=visible===0;
    }
  });

  /* Filters: each row offers only what its field can do, and asks for its value the right way */
  const filterRows=all('[data-report-filter]'),addFilter=one('[data-report-add-filter]'),filterCount=document.querySelector('[data-report-filter-count]');
  const partsOf=row=>({field:row.querySelector('[name$="[field]"]'),operator:row.querySelector('[name$="[operator]"]'),real:row.querySelector('[name$="[value]"]')});
  const kindOf=field=>schema.filterValues?.[field]?'choice':['number','money_minor'].includes(typeOf(field))?'number':typeOf(field)==='date'?'date':'text';
  const suggestions=new Map();
  const suggest=async(field,list)=>{
    if(!suggestions.has(field))suggestions.set(field,fetch('/reports/preview',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'},body:new URLSearchParams({_csrf:one('[name=_csrf]').value,dataset:one('[name=dataset]').value,title:'Values',groups:field,aggregate:'count',sort:'count',direction:'desc'})}).then(response=>response.json()).then(data=>data.ok?data.groupValues.map(row=>row[0]).filter(Boolean):[]).catch(()=>[]));
    const values=await suggestions.get(field);list.replaceChildren(...values.map(value=>{const option=document.createElement('option');option.value=value;return option;}));
  };
  function syncFilterRow(row,{fresh=false}={}){
    const {field,operator,real}=partsOf(row),index=filterRows.indexOf(row)+1,kind=kindOf(field.value);
    const known=(REPORT_OPERATORS[kind]||REPORT_OPERATORS.text).slice(),kept=operator.value;
    if(!fresh&&field.value&&kept&&!known.some(([value])=>value===kept)&&(real.value||REPORT_NO_VALUE.has(kept)))known.push([kept,kept==='at_least'?'is on or after':kept==='at_most'?'is on or before':REPORT_NO_VALUE.has(kept)?'is empty':kept.replaceAll('_',' ')]);
    operator.replaceChildren(...known.map(([value,label])=>new Option(label,value)));
    operator.value=!fresh&&known.some(([value])=>value===kept)?kept:(field.value==='currency'?'equals':known[0][0]);
    if(fresh)real.value='';
    syncFilterValue(row,index);
  }
  function syncFilterValue(row,index=filterRows.indexOf(row)+1){
    const {field,operator,real}=partsOf(row);
    row.querySelector('[data-report-filter-control]')?.remove();
    real.type='hidden';real.removeAttribute('aria-label');
    if(!field.value||REPORT_NO_VALUE.has(operator.value)){if(REPORT_NO_VALUE.has(operator.value))real.value='';row.classList.add('is-valueless');return;}
    row.classList.remove('is-valueless');
    const type=typeOf(field.value),values=schema.filterValues?.[field.value];let control;
    const label='Filter value '+index;
    if(operator.value==='relative'||(values&&['equals','is_not'].includes(operator.value))){
      control=document.createElement('select');
      const entries=operator.value==='relative'?Object.entries(schema.periods||{}):values.map(value=>[value,String(value).replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase())]);
      control.replaceChildren(...entries.map(([value,text])=>new Option(text,value)));
      if(entries.some(([value])=>value===real.value))control.value=real.value;else real.value=control.value;
      control.addEventListener('change',()=>{real.value=control.value;});
    }else{
      control=document.createElement('input');
      if(type==='date'){control.type='date';control.value=/^\d{4}-\d{2}-\d{2}$/.test(real.value)?real.value:'';if(!control.value)real.value='';control.addEventListener('input',()=>{real.value=control.value;});}
      else if(type==='money_minor'){control.type='number';control.step=String(1/minorPerUnit);control.placeholder=schema.currency||'Amount';control.value=real.value===''||!Number.isFinite(Number(real.value))?'':Number(real.value)/minorPerUnit;control.addEventListener('input',()=>{real.value=control.value===''?'':String(Math.round(Number(control.value)*minorPerUnit));});}
      else if(type==='number'){control.type='number';control.step='any';control.value=Number.isFinite(Number(real.value))?real.value:'';if(!control.value)real.value='';control.addEventListener('input',()=>{real.value=control.value;});}
      else{
        control.type='text';control.value=real.value;control.placeholder='Value';control.addEventListener('input',()=>{real.value=control.value;});
        const list=document.createElement('datalist');list.id='report-values-'+index;control.setAttribute('list',list.id);row.append(list);control.dataset.withList='1';
        control.addEventListener('focus',()=>suggest(field.value,list),{once:true});
      }
    }
    control.setAttribute('aria-label',label);control.setAttribute('data-report-filter-control','');
    row.insertBefore(control,row.querySelector('[data-report-remove-filter]'));
  }
  const isManaged=row=>row.hasAttribute('data-report-date-managed');
  const syncFilterSummary=()=>{
    const count=filterRows.filter(row=>{const {field,operator,real}=partsOf(row);return field.value&&(real.value||REPORT_NO_VALUE.has(operator.value));}).length;
    if(filterCount){filterCount.hidden=!count;filterCount.textContent=count||'';}
    if(addFilter)addFilter.hidden=!filterRows.some(row=>row.hidden&&!isManaged(row));
  };
  const clearRow=row=>{const {field,real}=partsOf(row);field.value='';real.value='';row.hidden=true;row.removeAttribute('data-report-date-managed');syncFilterRow(row,{fresh:true});};
  const freeRow=()=>filterRows.find(row=>row.hidden&&!isManaged(row)&&!partsOf(row).field.value);
  filterRows.forEach(row=>{
    const {field,operator}=partsOf(row);syncFilterRow(row);
    field.addEventListener('change',()=>syncFilterRow(row,{fresh:true}));
    operator.addEventListener('change',()=>syncFilterValue(row));
    row.querySelector('[data-report-remove-filter]').addEventListener('click',()=>{clearRow(row);changed();});
  });
  addFilter?.addEventListener('click',()=>{const next=freeRow();if(!next)return;next.hidden=false;partsOf(next).field.focus();syncFilterSummary();});
  const setFilter=(fieldKey,operatorKey,value)=>{
    const existing=filterRows.find(row=>partsOf(row).field.value===fieldKey&&partsOf(row).operator.value===operatorKey),row=existing||freeRow();if(!row)return null;
    const {field,operator,real}=partsOf(row);field.value=fieldKey;syncFilterRow(row,{fresh:true});operator.value=operatorKey;real.value=value;syncFilterValue(row);row.hidden=false;return row;
  };

  /* The date range: one quick choice that is written as ordinary filters */
  const dates=one('[data-report-dates]');
  if(dates){
    const fieldPicker=dates.querySelector('[data-report-date-field] select'),chips=[...dates.querySelectorAll('[data-report-period]')],custom=dates.querySelector('[data-report-custom]'),from=dates.querySelector('[data-report-custom-from]'),to=dates.querySelector('[data-report-custom-to]');
    dates.querySelector('[data-report-date-field]').hidden=fieldPicker.options.length<2;
    const managedRows=()=>filterRows.filter(row=>{const {field,operator}=partsOf(row);return field.value===fieldPicker.value&&['relative','after','before'].includes(operator.value);});
    const firstUsed=filterRows.map(row=>partsOf(row)).find(({field,operator})=>typeOf(field.value)==='date'&&['relative','after','before'].includes(operator.value));
    if(firstUsed)fieldPicker.value=firstUsed.field.value;
    const paint=()=>{
      const rows=managedRows().map(partsOf),relative=rows.find(row=>row.operator.value==='relative'),hasDates=rows.some(row=>row.operator.value!=='relative');
      const active=relative?relative.real.value:hasDates||chips.find(chip=>chip.dataset.reportPeriod==='custom').hasAttribute('data-open')?'custom':'';
      chips.forEach(chip=>chip.setAttribute('aria-pressed',String(chip.dataset.reportPeriod===active)));
      custom.hidden=active!=='custom';
      if(active==='custom'){from.value=rows.find(row=>row.operator.value==='after')?.real.value||from.value;to.value=rows.find(row=>row.operator.value==='before')?.real.value||to.value;}
    };
    const manage=()=>{
      filterRows.forEach(row=>{if(isManaged(row)){row.removeAttribute('data-report-date-managed');if(partsOf(row).field.value)row.hidden=false;}});
      managedRows().forEach(row=>{row.setAttribute('data-report-date-managed','');row.hidden=true;});
    };
    const clearManaged=()=>managedRows().forEach(clearRow);
    chips.forEach(chip=>chip.addEventListener('click',()=>{
      const period=chip.dataset.reportPeriod,customChip=chips.find(row=>row.dataset.reportPeriod==='custom');
      customChip.toggleAttribute('data-open',period==='custom');clearManaged();
      if(period&&period!=='custom')setFilter(fieldPicker.value,'relative',period);
      if(period==='custom'){if(from.value)setFilter(fieldPicker.value,'after',from.value);if(to.value)setFilter(fieldPicker.value,'before',to.value);}
      manage();paint();syncFilterSummary();changed();
    }));
    for(const [input,operator] of [[from,'after'],[to,'before']])input.addEventListener('change',()=>{
      const row=filterRows.find(item=>partsOf(item).field.value===fieldPicker.value&&partsOf(item).operator.value===operator);
      if(row)clearRow(row);
      if(input.value)setFilter(fieldPicker.value,operator,input.value);
      manage();syncFilterSummary();changed();
    });
    fieldPicker.addEventListener('change',()=>{
      const moving=filterRows.filter(isManaged).map(row=>({operator:partsOf(row).operator.value,value:partsOf(row).real.value}));
      filterRows.filter(isManaged).forEach(clearRow);
      moving.forEach(item=>setFilter(fieldPicker.value,item.operator,item.value));
      manage();paint();changed();
    });
    manage();paint();
  }

  /* Money only adds up in one currency, and some amounts are only known for some records.
     Add the filter that makes the total honest, where the person can see and change it. */
  function moneyScopeNeeded(){
    if(modeNow()==='list')return [];
    const needs=[],groups=groupsNow(),filtersNow=filterRows.map(partsOf).filter(row=>row.field.value);
    const exactCurrency=filtersNow.some(row=>row.field.value==='currency'&&row.operator.value==='equals'&&/^[A-Z]{3}$/.test(row.real.value));
    for(const {kind,field:chosen} of [{kind:aggregate.value,field:measure.value},...activeExtras()]){
      const moneyTotal=['sum','average','minimum','maximum'].includes(kind)&&typeOf(chosen)==='money_minor';
      const moneyRatio=kind==='ratio'&&schema.metrics?.[chosen]?.currencySensitive;
      if((moneyTotal||moneyRatio)&&fields.currency&&schema.currency&&!groups.includes('currency')&&!exactCurrency&&!needs.some(need=>need[0]==='currency'))needs.push(['currency','equals',schema.currency]);
      const known=['sum','average','minimum','maximum'].includes(kind)?schema.moneyCompleteness?.[chosen]:null;
      if(known&&!filtersNow.some(row=>row.field.value===known.field&&row.operator.value==='equals'&&row.real.value===String(known.value))&&!needs.some(need=>need[0]===known.field))needs.push([known.field,'equals',String(known.value)]);
    }
    return needs;
  }
  function requireMoneyScope(){for(const [field,operator,value] of moneyScopeNeeded())setFilter(field,operator,value);syncFilterSummary();}

  /* Comparing needs a date range to compare against */
  const compare=one('[data-report-compare]'),compareHint=one('[data-report-compare-hint]');
  function syncCompare(){
    if(!compare)return;
    const dated=filterRows.map(partsOf).some(({field,operator,real})=>typeOf(field.value)==='date'&&['relative','after','at_least'].includes(operator.value)&&real.value);
    compare.disabled=!dated||modeNow()==='list';if(!dated)compare.value='';if(compareHint)compareHint.hidden=dated;
  }

  /* One-click next steps, from what this source can actually answer */
  const tryArea=one('[data-report-try]');
  const usefulGroups=()=>Object.keys(fields).filter(key=>typeOf(key)==='text'&&key!=='currency'&&!/number|code|sku|reference|source|note|description|email|phone|address|barcode|id$/.test(key)&&[...groupSelects[0].options].some(option=>option.value===key));
  const fireChange=node=>node.dispatchEvent(new Event('change',{bubbles:true}));
  function syncTry(){
    if(!tryArea)return;
    const current=modeNow(),moves=[],groups=groupsNow(),dateFields=Object.keys(fields).filter(key=>typeOf(key)==='date'&&[...groupSelects[0].options].some(option=>option.value===key));
    const groupBy=(field,grainValue)=>{groupSelects[0].value=field;groupSelects.slice(1).forEach(select=>{select.value='';});if(grainValue)grain.value=grainValue;fireChange(groupSelects[0]);};
    const toGroups=(field,grainValue)=>{if(modeNow()!=='groups'){modes.find(radio=>radio.value==='groups').checked=true;groupSelects[0].value=field;fireChange(modes.find(radio=>radio.value==='groups'));}groupBy(field,grainValue);};
    const name=key=>labelOf(key).toLowerCase();
    if(current==='list'||current==='summary')usefulGroups().slice(0,4).forEach(key=>moves.push(['Totals by '+name(key),()=>toGroups(key)]));
    if(current==='groups'){
      const dated=groups.find(key=>typeOf(key)==='date');
      if(dated){for(const [value,label] of [['week','By week'],['month','By month'],['quarter','By quarter']])if(grain.value!==value)moves.push([label,()=>{grain.value=value;fireChange(grain);}]);}
      else if(dateFields[0])moves.push(['Over time',()=>toGroups(dateFields[0],'month')]);
      usefulGroups().filter(key=>!groups.includes(key)).slice(0,4).forEach(key=>moves.push(['By '+name(key),()=>toGroups(key)]));
      if(!dated&&!one('[name=topN]').value)moves.push(['Top 10',()=>{one('[name=topN]').value=10;sort.value=resultColumn();direction.value='desc';fireChange(one('[name=topN]'));}]);
    }
    if(current!=='list'){
      const used=new Set([measure.value,...activeExtras().map(extra=>extra.field)]);
      numericFields.filter(key=>typeOf(key)==='money_minor'&&!used.has(key)).slice(0,3).forEach(key=>{if(extraRows.some(row=>row.hidden))moves.push(['+ '+(measureChoices[key]||labelOf(key)),()=>{addExtra('sum',key);changed();}]);});
    }
    tryArea.replaceChildren();tryArea.hidden=!moves.length;
    if(!moves.length)return;
    tryArea.append(reportElement('span','','Try'));
    for(const [label,action] of moves.slice(0,8)){const button=reportElement('button','',label);button.type='button';button.addEventListener('click',()=>{action();syncTry();});tryArea.append(button);}
  }

  /* Live results */
  const status=document.querySelector('[data-report-preview-status]'),canvas=document.querySelector('#report-canvas');
  const tableArea=document.querySelector('[data-report-preview-table]'),chartArea=document.querySelector('[data-report-preview-chart]'),bigArea=document.querySelector('[data-report-preview-big]'),insightsArea=document.querySelector('[data-report-preview-insights]'),note=document.querySelector('[data-report-preview-note]');
  const jump=document.querySelector('[data-report-jump]');
  const say=text=>{status.textContent=text;if(jump)jump.textContent=/shown/.test(text)?'See the results · '+text.split(' · ')[0]:'See the results';};
  let lastChart='';
  const clearResults=()=>{tableArea.replaceChildren();chartArea.replaceChildren();chartArea.hidden=true;bigArea.hidden=true;insightsArea.hidden=true;note.hidden=true;lastChart='';};
  const drilldown=(definition,groupValues)=>{
    const form=document.createElement('form');form.method='post';form.action='/reports/drilldown';
    for(const [name,text] of Object.entries({_csrf:one('[name=_csrf]').value,definition:JSON.stringify(definition),groupValues:JSON.stringify(groupValues)})){const input=document.createElement('input');input.type='hidden';input.name=name;input.value=text;form.append(input);}
    document.body.append(form);form.submit();
  };
  const cellText=(data,key,row)=>{const value=row[key];if(data.columnTypes?.[key]==='date'||typeOf(key)==='date')return reportDateText(value,data.definition.groups?.includes(key)?data.definition.dateGrain:'exact');const text=String(value??'—');return /^[a-z]+(_[a-z]+)+$/.test(text)?text.replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase()):text;};
  const groupLabel=(data,index)=>data.definition.groups.map(key=>cellText(data,key,data.rows[index])).join(' · ');
  const axisText=(data,value)=>{
    if(data.columnTypes?.[data.chart.column]==='money_minor'){
      const currency=data.definition.filters?.find(filter=>filter.field==='currency'&&filter.operator==='equals')?.value||schema.currency||'USD';
      return new Intl.NumberFormat(undefined,{style:'currency',currency,notation:'compact',maximumFractionDigits:1}).format(value/minorPerUnit);
    }
    return new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value);
  };
  function drawBars(data){
    const shown=data.rows.slice(0,20),values=data.chart.values.slice(0,20),peak=Math.max(1,...values.map(Math.abs));
    const bars=reportElement('div','report-bars');
    shown.forEach((row,index)=>{
      const bar=reportElement('button','report-bar');bar.type='button';bar.setAttribute('aria-label','Open the records for '+groupLabel(data,index));
      const fill=reportElement('i');if(values[index]<0)fill.classList.add('is-negative');fill.style.width='0';
      const track=reportElement('span','report-bar__track');track.append(fill);
      bar.append(reportElement('span','report-bar__label',groupLabel(data,index)),track,reportElement('strong','',String(row[data.chart.column]??'—')));
      bar.addEventListener('click',()=>drilldown(data.definition,data.groupValues[index]));bars.append(bar);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.width=Math.max(1,Math.abs(values[index])/peak*100)+'%';}));
    });
    chartArea.append(bars);
    if(data.rows.length>20)chartArea.append(reportElement('p','report-preview-note','The chart shows the first 20 groups.'));
  }
  function drawLine(data){
    const values=data.chart.values,count=values.length,earlier=data.previousSeries?.column===data.chart.column?data.previousSeries.values:null,known=(earlier||[]).filter(value=>value!==null),low=Math.min(0,...values,...known),high=Math.max(1,...values,...known),span=high-low||1;
    const x=index=>index/(count-1)*100,y=value=>100-(value-low)/span*100;
    const path=values.map((value,index)=>(index?'L':'M')+x(index).toFixed(2)+' '+y(value).toFixed(2)).join(' ');
    const plot=reportElement('div','report-plot');
    for(const value of [high,(high+low)/2,low]){const line=reportElement('div','report-plot__grid');line.style.top=y(value)+'%';line.append(reportElement('span','',axisText(data,value)));plot.append(line);}
    const space='http://www.w3.org/2000/svg',svg=document.createElementNS(space,'svg');svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label','Line chart of '+data.definition.title);
    const area=document.createElementNS(space,'path');area.setAttribute('d',path+' L100 '+y(Math.max(low,0))+' L0 '+y(Math.max(low,0))+' Z');area.setAttribute('class','report-plot__area');
    const stroke=document.createElementNS(space,'path');stroke.setAttribute('d',path);stroke.setAttribute('class','report-plot__line');stroke.setAttribute('vector-effect','non-scaling-stroke');
    if(data.definition.chart==='area')svg.append(area);
    if(earlier){let pen='M',trail='';earlier.forEach((value,index)=>{if(value===null){pen='M';return;}trail+=pen+x(index).toFixed(2)+' '+y(value).toFixed(2)+' ';pen='L';});const ghost=document.createElementNS(space,'path');ghost.setAttribute('d',trail);ghost.setAttribute('class','report-plot__earlier');ghost.setAttribute('vector-effect','non-scaling-stroke');svg.append(ghost);}
    svg.append(stroke);plot.append(svg);
    const cross=reportElement('div','report-plot__cross'),dot=reportElement('div','report-plot__dot'),tip=reportElement('div','report-plot__tip');cross.hidden=dot.hidden=tip.hidden=true;plot.append(cross,dot,tip);
    const point=event=>{
      const box=plot.getBoundingClientRect(),index=Math.max(0,Math.min(count-1,Math.round((event.clientX-box.left)/box.width*(count-1))));
      const left=x(index),top=y(values[index]);cross.hidden=dot.hidden=tip.hidden=false;cross.style.left=dot.style.left=left+'%';dot.style.top=top+'%';
      tip.replaceChildren(reportElement('span','',groupLabel(data,index)),reportElement('strong','',String(data.rows[index][data.chart.column]??'—')),...(earlier&&earlier[index]!==null?[reportElement('span','','Earlier: '+axisText(data,earlier[index]))]:[]));
      tip.style.left=left+'%';tip.style.top=top+'%';tip.classList.toggle('is-left',left>60);plot.dataset.index=index;
    };
    plot.addEventListener('pointermove',point);plot.addEventListener('pointerleave',()=>{cross.hidden=dot.hidden=tip.hidden=true;});
    plot.addEventListener('click',()=>{const index=Number(plot.dataset.index);if(Number.isInteger(index))drilldown(data.definition,data.groupValues[index]);});
    const axis=reportElement('div','report-plot__axis');for(const index of [...new Set([0,Math.floor((count-1)/2),count-1])])axis.append(reportElement('span','',groupLabel(data,index)));
    chartArea.append(plot,axis);
    if(earlier)chartArea.append(reportElement('p','report-preview-note','Solid line: this period. Dashed line: the earlier period.'));
  }
  function drawColumns(data){
    const values=data.chart.values,count=values.length,low=Math.min(0,...values),high=Math.max(1,...values),span=high-low||1;
    const y=value=>100-(value-low)/span*100;
    const plot=reportElement('div','report-plot report-plot--columns');
    for(const value of [high,(high+low)/2,low]){const line=reportElement('div','report-plot__grid');line.style.top=y(value)+'%';line.append(reportElement('span','',axisText(data,value)));plot.append(line);}
    const tip=reportElement('div','report-plot__tip');tip.hidden=true;
    values.forEach((value,index)=>{
      const column=reportElement('button','report-column');column.type='button';column.setAttribute('aria-label',groupLabel(data,index)+': '+String(data.rows[index][data.chart.column]??'—'));
      column.style.left=index/count*100+'%';column.style.width=100/count+'%';
      const fill=reportElement('i');if(value<0)fill.classList.add('is-negative');fill.style.top=y(Math.max(value,0))+'%';fill.style.bottom=100-y(Math.min(value,0))+'%';column.append(fill);
      const show=()=>{tip.hidden=false;tip.replaceChildren(reportElement('span','',groupLabel(data,index)),reportElement('strong','',String(data.rows[index][data.chart.column]??'—')));const middle=(index+.5)/count*100;tip.style.left=middle+'%';tip.style.top=y(Math.max(value,0))+'%';tip.classList.toggle('is-left',middle>60);};
      column.addEventListener('pointerenter',show);column.addEventListener('focus',show);column.addEventListener('pointerleave',()=>{tip.hidden=true;});
      column.addEventListener('click',()=>drilldown(data.definition,data.groupValues[index]));plot.append(column);
    });
    plot.append(tip);
    const axis=reportElement('div','report-plot__axis');for(const index of [...new Set([0,Math.floor((count-1)/2),count-1])])axis.append(reportElement('span','',groupLabel(data,index)));
    chartArea.append(plot,axis);
  }
  function drawChart(data){
    const wanted=data.definition.groups?.length&&data.definition.chart!=='table'&&data.rows.length;
    const signature=wanted?JSON.stringify([data.definition.chart,data.chart.column,data.chart.values,data.groupValues,data.labels,data.previousSeries]):'';
    if(signature===lastChart&&signature)return;
    lastChart=signature;chartArea.replaceChildren();chartArea.hidden=!wanted;
    if(!wanted)return;
    if(!data.chart.comparable||!data.chart.plottable){chartArea.append(reportElement('p','report-error',data.chart.comparable?'This chart cannot safely plot these values. The exact figures are in the table.':'This may include different currencies. Filter to one currency to compare amounts. The exact figures are in the table.'));return;}
    const overTime=data.definition.groups.length===1&&typeOf(data.definition.groups[0])==='date'&&data.definition.sort===data.definition.groups[0]&&data.rows.length>1;
    if(['donut','stacked','pivot'].includes(data.definition.chart)){
      const metricName=data.labels?.[data.chart.column]||'Total',money=data.columnTypes?.[data.chart.column]==='money_minor',currency=data.definition.filters?.find(filter=>filter.field==='currency'&&filter.operator==='equals')?.value||schema.currency||'USD';
      const format=value=>money?new Intl.NumberFormat(undefined,{style:'currency',currency}).format(value/minorPerUnit):new Intl.NumberFormat().format(value);
      const groups=data.definition.groups,textOf=(index,key)=>cellText(data,key,data.rows[index]);
      const items=data.rows.map((row,index)=>({index,value:data.chart.values[index],display:String(row[data.chart.column]??'—'),label:groupLabel(data,index),first:textOf(index,groups[0]),second:groups[1]?textOf(index,groups[1]):''}));
      const whole=data.totals?.metrics?.find(metric=>metric.column===data.chart.column);
      window.ReportCharts.draw(data.definition.chart,chartArea,{items,format,metricName,groupName:data.labels?.[groups[0]]||labelOf(groups[0]),totalDisplay:whole?.display||'',onPick:index=>drilldown(data.definition,data.groupValues[index])});
      if(data.hasMore)chartArea.append(reportElement('p','report-preview-note','Showing the first '+data.returned+' rows.'));
    }else if(['line','area'].includes(data.definition.chart)&&data.rows.length>1)drawLine(data);else if(overTime)drawColumns(data);else drawBars(data);
  }
  const shortDay=value=>reportDateText(value,'day');
  function drawBig(data){
    const totals=data.totals,metrics=totals?.metrics||[];
    bigArea.replaceChildren();bigArea.hidden=!metrics.length;
    if(!metrics.length)return;
    const choosable=metrics.length>1&&data.definition.groups?.length&&data.definition.chart!=='table';
    for(const metric of metrics){
      const tile=reportElement(choosable?'button':'div','report-kpi');
      if(choosable){
        tile.type='button';tile.setAttribute('aria-pressed',String(metric.column===data.chart.column));tile.title='Chart '+metric.label;
        tile.addEventListener('click',()=>{
          chartMeasure.value=metric.column===metrics[0].column?'':metric.column;
          const overTime=groupsNow().length===1&&typeOf(groupsNow()[0])==='date';
          if(!overTime&&[...sort.options].some(option=>option.value===metric.column)){sort.value=metric.column;direction.value='desc';}
          changed();
        });
      }
      tile.append(reportElement('span','',metric.label),reportElement('strong','',metric.display));
      const overTimeNow=data.definition.groups?.length===1&&typeOf(data.definition.groups[0])==='date',trend=overTimeNow?(data.metricValues?.[metric.column]||[]):[];
      if(trend.length>1&&window.ReportCharts){const line=window.ReportCharts.spark(data.definition.direction==='desc'?[...trend].reverse():trend);if(line)tile.append(line);}
      if(metric.change!==null&&metric.change!==undefined)tile.append(reportElement('small','report-delta '+(metric.good===true?'is-good':metric.good===false?'is-bad':''),(metric.change>0?'▲ ':metric.change<0?'▼ ':'')+Math.abs(metric.change).toFixed(1)+'%'));
      if(metric.previousDisplay)tile.append(reportElement('em','','was '+metric.previousDisplay));else if(totals.comparison)tile.append(reportElement('em','','No earlier records'));
      bigArea.append(tile);
    }
    if(totals.comparison)bigArea.append(reportElement('p','report-kpis__note',shortDay(totals.comparison.from)+' – '+shortDay(totals.comparison.to)+' compared with '+shortDay(totals.comparison.previousFrom)+' – '+shortDay(totals.comparison.previousTo)));
    if(data.definition.summary){const open=reportElement('button','report-source-link','See the records behind this');open.type='button';open.addEventListener('click',()=>drilldown(data.definition,[]));bigArea.append(open);}
  }
  function drawInsights(data){
    const list=data.insights||[];insightsArea.hidden=!list.length;insightsArea.replaceChildren();
    if(!list.length)return;
    insightsArea.append(reportElement('h3','','What stands out'));
    for(const insight of list.slice(0,3)){const line=reportElement('p');line.append(reportElement('strong','',insight.title+'.'),' '+insight.text);insightsArea.append(line);}
  }
  function drawTable(data){
    tableArea.replaceChildren();tableArea.hidden=Boolean(data.definition.summary);
    if(data.definition.summary)return;
    const table=document.createElement('table'),head=table.createTHead().insertRow(),metricNames=data.metricColumns||[];
    const primary=data.definition.groups?.length&&typeOf(data.definition.groups[0])!=='date'?metricNames[0]:null,primaryValues=primary?(data.metricValues?.[primary]||[]):[],peakValue=Math.max(1,...primaryValues.map(Math.abs)),whole=data.totals?.metrics?.find(metric=>metric.column===primary)?.value,canShare=primary&&data.definition.aggregate==='sum'&&whole>0&&primaryValues.every(value=>value>=0);
    for(const key of data.columns){
      const cell=document.createElement('th');cell.scope='col';const text=data.definition.columnLabels?.[key]||data.labels[key]||fields[key]?.label||key;
      if([...sort.options].some(option=>option.value===key)){
        const button=reportElement('button','report-sort',text);button.type='button';
        if(data.definition.sort===key){cell.setAttribute('aria-sort',data.definition.direction==='asc'?'ascending':'descending');button.dataset.direction=data.definition.direction;}
        button.addEventListener('click',()=>{const same=sort.value===key;if(![...sort.options].some(option=>option.value===key))return;sort.value=key;direction.value=same&&direction.value==='desc'?'asc':'desc';sort.dispatchEvent(new Event('change',{bubbles:true}));});
        cell.append(button);
      }else cell.textContent=text;
      if(['money_minor','number'].includes(data.columnTypes?.[key]))cell.classList.add('is-num');
      head.append(cell);
    }
    if(canShare){const cell=document.createElement('th');cell.scope='col';cell.className='is-num';cell.textContent='Share';head.append(cell);}
    const body=table.createTBody();
    for(const [index,row] of data.rows.entries()){
      const line=body.insertRow();
      for(const key of data.columns){
        const cell=line.insertCell(),value=cellText(data,key,row);
        if(['money_minor','number'].includes(data.columnTypes?.[key]))cell.classList.add('is-num');
        if(key==='change'&&/^[+-]/.test(value))cell.classList.add(value.startsWith('+')?'is-up':'is-down');
        if(data.groups?.length&&metricNames.includes(key)){
          const button=reportElement('button','report-source-link',value);button.type='button';button.setAttribute('aria-label','Show records behind '+value);
          button.addEventListener('click',()=>drilldown(data.definition,data.groupValues[index]));cell.append(button);
        }else if(data.links?.[index]?.startsWith('/')&&!data.links[index].startsWith('//')&&key===data.columns[0]){
          const link=document.createElement('a');link.href=data.links[index];link.textContent=value;cell.append(link);
        }else cell.textContent=value;
        if(key===primary&&primaryValues.length){cell.classList.add('has-bar');cell.style.setProperty('--bar',Math.round(Math.abs(primaryValues[index])/peakValue*100)+'%');}
      }
      if(canShare){const cell=line.insertCell();cell.className='is-num report-share';cell.textContent=(primaryValues[index]/whole*100).toFixed(1)+'%';}
    }
    const wholes=data.totals?.metrics||[];
    if(data.definition.groups?.length&&wholes.length){
      const foot=table.createTFoot().insertRow();
      for(const key of data.columns){const cell=foot.insertCell(),metric=wholes.find(entry=>entry.column===key);if(key===data.columns[0])cell.textContent='Total';else if(metric){cell.textContent=metric.display;cell.classList.add('is-num');}else if(['money_minor','number'].includes(data.columnTypes?.[key]))cell.classList.add('is-num');}
      if(canShare)foot.insertCell();
    }
    tableArea.append(table);
    if(data.rows.length>8&&!data.definition.summary){
      const find=reportElement('input','report-find');find.type='search';find.placeholder='Find in these results';find.setAttribute('aria-label','Find in these results');
      find.addEventListener('input',()=>{const needle=find.value.trim().toLowerCase();for(const row of table.tBodies[0].rows)row.hidden=Boolean(needle)&&!row.textContent.toLowerCase().includes(needle);});
      find.addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
      tableArea.prepend(find);
    }
  }
  const draw=data=>{
    if(!data.rows.length){clearResults();drawBig(data);tableArea.hidden=false;tableArea.append(reportElement('p','report-empty','No records match these choices. Try a wider date or remove a filter.'));say('No records match these choices.');return;}
    say(data.returned+(data.hasMore?'+':'')+(data.returned===1?' row shown · ':' rows shown · ')+(data.elapsedMs/1000).toFixed(1)+' s');
    drawBig(data);drawChart(data);drawInsights(data);drawTable(data);
    note.hidden=!data.hasMore;note.textContent=data.hasMore?'Showing the first '+data.returned+' rows. Run the report to see all of them.':'';
  };
  const askFirst=()=>{
    const current=modeNow();
    if(current==='list'&&!order.length)return 'Choose at least one column.';
    if(current==='groups'&&!groupsNow().length)return 'Choose what to group by.';
    return '';
  };
  let timer,controller,revision=0;
  const load=async()=>{
    const current=++revision;controller?.abort();controller=new AbortController();
    try{
      const response=await fetch('/reports/preview',{method:'POST',body:new URLSearchParams(new FormData(builder)),headers:{Accept:'application/json'},credentials:'same-origin',signal:controller.signal});
      const data=await response.json();if(current!==revision)return;
      canvas.classList.remove('is-updating');
      if(!data.ok){clearResults();say(data.message||'Choose valid report fields.');return;}
      draw(data);
    }catch(error){if(error.name!=='AbortError'&&current===revision){canvas.classList.remove('is-updating');clearResults();say('Preview unavailable. Try again or open the full report.');}}
  };
  const schedule=()=>{
    clearTimeout(timer);revision++;controller?.abort();
    const waiting=askFirst();
    if(waiting){canvas.classList.remove('is-updating');clearResults();say(waiting);return;}
    canvas.classList.add('is-updating');status.textContent='Updating preview…';timer=setTimeout(load,300);
  };
  builder.addEventListener('input',event=>{if(event.target.name==='title')return;schedule();});
  builder.addEventListener('change',event=>{if(event.target.name==='title'||event.target.closest('[data-report-schedule],[data-report-picker] [data-report-field-search]'))return;syncFilterSummary();syncCompare();syncTry();schedule();});
  applyMode();renderColumns();requireMoneyScope();syncFilterSummary();syncCompare();syncTry();schedule();
}

document.addEventListener('DOMContentLoaded',()=>{
  const describe=document.querySelector('[data-report-describe]');let buildingReport=false;
  describe?.addEventListener('submit',async event=>{event.preventDefault();if(buildingReport)return;buildingReport=true;const button=describe.querySelector('button[type=submit]'),status=describe.querySelector('[data-report-build-status]');button.disabled=true;status.hidden=false;status.textContent='Building your report from your business records…';try{const response=await fetch(describe.action,{method:'POST',credentials:'same-origin',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(describe))});const result=await response.json();if(!response.ok||!result.ok)throw Error(result.message||result.error?.message||'This report could not be built. Your description is kept here.');status.textContent='Ready: '+result.title;location.assign(result.url);}catch(error){buildingReport=false;status.textContent=error.message;status.setAttribute('role','alert');button.disabled=false;describe.querySelector('textarea').focus();}});
  for(const example of document.querySelectorAll('[data-report-example]'))example.addEventListener('click',()=>{const box=describe.querySelector('textarea');box.value=example.textContent;box.focus();});
  // The download menu closes once a format is chosen, and when clicking elsewhere.
  document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.report-download[open],.report-picker[open]')){const inside=menu.contains(event.target),chose=menu.matches('.report-download')&&event.target.closest('button,a');if(!inside||chose)setTimeout(()=>{menu.open=false;},0);}});
  const builder=document.querySelector('[data-report-builder]');
  if(builder)setupReportBuilder(builder);
  for(const group of document.querySelectorAll('[data-report-schedule]')){
    const frequency=group.querySelector('[name=frequency]');
    const sync=()=>{for(const row of group.querySelectorAll('[data-schedule-when]'))row.hidden=!row.dataset.scheduleWhen.split(' ').includes(frequency.value);};
    frequency.addEventListener('change',sync);sync();
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
});
