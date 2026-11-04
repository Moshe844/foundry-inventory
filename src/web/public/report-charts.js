'use strict';
// Charts shared by the report builder and the full report page. Every value comes from the report's own rows.
(function(){
  // Validated fixed order: a colour follows its slot, it is never recycled. Past eight, rows fold into Other.
  const COLORS=['#4F46E5','#EB6834','#1BAF7A','#EDA100','#E87BA4','#008300','#0284C7','#E34948'];
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const svgNode=(tag,attributes)=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes||{}))node.setAttribute(key,value);return node;};
  const legend=entries=>{const list=make('ul','rc-legend');for(const entry of entries){const row=make('li');const swatch=make('i');swatch.style.background=entry.color;row.append(swatch,make('span','',entry.label));if(entry.value)row.append(make('strong','',entry.value));list.append(row);}return list;};

  // A share of the whole: the largest parts, the rest folded together.
  function donut(area,data){
    const positive=data.items.map((item,index)=>({...item,index})).filter(item=>item.value>0).sort((a,b)=>b.value-a.value);
    const total=positive.reduce((sum,item)=>sum+item.value,0);
    if(!total){area.append(make('p','report-preview-note','There is nothing positive to share out here. The exact figures are in the table.'));return;}
    const shown=positive.slice(0,7),rest=positive.slice(7),parts=rest.length?[...shown,{label:'Other',value:rest.reduce((sum,item)=>sum+item.value,0),display:rest.length+' more'}]:shown;
    const wrap=make('div','rc-donut'),svg=svgNode('svg',{viewBox:'0 0 120 120',role:'img','aria-label':'Share of total by '+data.groupName});
    const radius=48,circumference=2*Math.PI*radius,tip=make('div','rc-donut__center');
    const centre=(label,value)=>tip.replaceChildren(make('strong','',value),make('span','',label));
    centre(data.metricName,data.totalDisplay||'');
    let offset=0;
    parts.forEach((part,slot)=>{
      const length=part.value/total*circumference,color=part.label==='Other'&&rest.length?'#AEB4C6':COLORS[slot%COLORS.length];
      const arc=svgNode('circle',{cx:60,cy:60,r:radius,fill:'none',stroke:color,'stroke-width':15,'stroke-dasharray':Math.max(0,length-1.2)+' '+(circumference-Math.max(0,length-1.2)),'stroke-dashoffset':-offset,transform:'rotate(-90 60 60)',tabindex:0});
      arc.style.cursor=part.index===undefined?'default':'pointer';
      const share=Math.round(part.value/total*1000)/10+'%';
      arc.addEventListener('pointerenter',()=>centre(part.label,share));arc.addEventListener('focus',()=>centre(part.label,share));arc.addEventListener('pointerleave',()=>centre(data.metricName,data.totalDisplay||''));
      if(part.index!==undefined&&data.onPick)arc.addEventListener('click',()=>data.onPick(part.index));
      svg.append(arc);part.color=color;part.share=share;offset+=length;
    });
    const ring=make('div','rc-donut__ring');ring.append(svg,tip);
    const list=make('ul','rc-donut__list');
    for(const part of parts){const row=make('li');const swatch=make('i');swatch.style.background=part.color;row.append(swatch,make('span','',part.label),make('b','',part.share),make('strong','',part.display||''));list.append(row);}
    wrap.append(ring,list);area.append(wrap);
  }

  function pivotOf(data){
    const across=new Map(),down=new Map();
    for(const item of data.items){across.set(item.second,(across.get(item.second)||0)+Math.abs(item.value));if(!down.has(item.first))down.set(item.first,new Map());down.get(item.first).set(item.second,item);}
    return {down,across:[...across.entries()].sort((a,b)=>b[1]-a[1]).map(([key])=>key)};
  }
  // Each row split into its second group, biggest parts first.
  function stacked(area,data){
    const {down,across}=pivotOf(data),shown=across.slice(0,7),others=across.length>7;
    const series=[...shown,...(others?['Other']:[])],colorOf=name=>name==='Other'&&others?'#AEB4C6':COLORS[series.indexOf(name)%COLORS.length];
    const rows=[...down.entries()].map(([label,cells])=>{const parts=series.map(name=>name==='Other'&&others?[...cells.entries()].filter(([key])=>!shown.includes(key)).reduce((sum,[,item])=>sum+Math.max(0,item.value),0):Math.max(0,cells.get(name)?.value||0));return {label,parts,total:parts.reduce((sum,value)=>sum+value,0),cells};}).sort((a,b)=>b.total-a.total).slice(0,20);
    const peak=Math.max(1,...rows.map(row=>row.total)),list=make('div','rc-stack');
    for(const row of rows){
      const line=make('div','rc-stack__row'),track=make('div','rc-stack__track');
      row.parts.forEach((value,slot)=>{if(!value)return;const piece=make('button','rc-stack__piece');piece.type='button';piece.style.width=value/peak*100+'%';piece.style.background=colorOf(series[slot]);const cell=row.cells.get(series[slot]);piece.title=row.label+' · '+series[slot]+': '+(cell?.display||data.format(value));piece.setAttribute('aria-label',piece.title);if(cell&&data.onPick)piece.addEventListener('click',()=>data.onPick(cell.index));track.append(piece);});
      line.append(make('span','rc-stack__label',row.label),track,make('strong','',data.format(row.total)));list.append(line);
    }
    area.append(legend(series.map(name=>({label:name,color:colorOf(name)}))),list);
  }
  // A cross-tab: first group down the side, second across the top, darker where the number is bigger.
  function pivot(area,data){
    const {down,across}=pivotOf(data),columns=across.slice(0,12),peak=Math.max(1,...data.items.map(item=>Math.abs(item.value)));
    const wrap=make('div','rc-pivot'),table=make('table'),head=table.createTHead().insertRow();
    head.append(make('th','',data.groupName));for(const name of columns)head.append(make('th','is-num',name));head.append(make('th','is-num','Total'));
    const body=table.createTBody(),totals=new Map();let all=0;
    for(const [label,cells] of down){
      const row=body.insertRow();row.append(make('th','',label));let sum=0;
      for(const name of columns){const item=cells.get(name),cell=row.insertCell();cell.className='is-num';if(item){sum+=item.value;totals.set(name,(totals.get(name)||0)+item.value);cell.textContent=item.display;cell.style.background='rgba(79,70,229,'+(Math.abs(item.value)/peak*.32).toFixed(3)+')';if(data.onPick){cell.classList.add('is-pick');cell.addEventListener('click',()=>data.onPick(item.index));}}else cell.textContent='—';}
      all+=sum;const end=row.insertCell();end.className='is-num is-total';end.textContent=data.format(sum);
    }
    const foot=table.createTFoot().insertRow();foot.append(make('th','','Total'));for(const name of columns){const cell=foot.insertCell();cell.className='is-num';cell.textContent=data.format(totals.get(name)||0);}const grand=foot.insertCell();grand.className='is-num';grand.textContent=data.format(all);
    wrap.append(table);area.append(wrap);
    if(across.length>12)area.append(make('p','report-preview-note','Showing the 12 biggest columns. The table has every row.'));
  }
  // A small trend inside a total.
  function spark(values){
    if(values.length<2)return null;
    const low=Math.min(...values),high=Math.max(...values),span=high-low||1,x=index=>index/(values.length-1)*100,y=value=>26-(value-low)/span*22;
    const svg=svgNode('svg',{viewBox:'0 0 100 30',preserveAspectRatio:'none',class:'rc-spark','aria-hidden':'true'});
    svg.append(svgNode('path',{d:values.map((value,index)=>(index?'L':'M')+x(index).toFixed(2)+' '+y(value).toFixed(2)).join(' '),fill:'none',stroke:'currentColor','stroke-width':2,'vector-effect':'non-scaling-stroke','stroke-linejoin':'round','stroke-linecap':'round'}));
    return svg;
  }
  const draw=(kind,area,data)=>({donut,stacked,pivot})[kind](area,data);
  window.ReportCharts={draw,spark,COLORS};
  // The full report page draws from the data the server placed beside the chart.
  document.addEventListener('DOMContentLoaded',()=>{
    for(const area of document.querySelectorAll('[data-report-client-chart]')){
      let data;try{data=JSON.parse(area.getAttribute('data-report-client-chart'));}catch{continue;}
      const money=data.currency?new Intl.NumberFormat(undefined,{style:'currency',currency:data.currency}):new Intl.NumberFormat();
      draw(data.kind,area,{...data,format:value=>money.format(data.currency?value/data.minorPerUnit:value)});
    }
    for(const box of document.querySelectorAll('[data-report-table-search]')){
      const table=document.querySelector(box.getAttribute('data-report-table-search'));
      box.addEventListener('input',()=>{const needle=box.value.trim().toLowerCase();for(const row of table?.tBodies[0]?.rows||[])row.hidden=Boolean(needle)&&!row.textContent.toLowerCase().includes(needle);});
    }
  });
})();
