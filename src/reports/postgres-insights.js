'use strict';

// Observations are derived only from the already-authorized report rows.
// They describe recorded differences; they never infer causes or invent forecasts.
function observations(result){
  const groups=result?.config?.groups||[],rows=result?.rows||[],columns=result?.columns||[];
  if(result?.comparisonSafe===false||!groups.length||rows.length<2||!columns.length)return [];
  const metric=columns.at(-1);
  const values=rows.map((row)=>Number(row[metric]));
  if(values.some((value)=>!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER))return [];
  const label=(row)=>groups.map((field)=>String(row[field]??'Not recorded')).join(' · ');
  const shown=(index)=>String(result.displayRows?.[index]?.[metric]??rows[index][metric]);
  const scope=result.hasMore?' among the displayed groups':'';
  if(result.config.chart==='line'&&groups.length===1){
    const first=0,last=rows.length-1;
    const movement=values[last]>values[first]?'rose':values[last]<values[first]?'fell':'stayed the same';
    return [{title:'Recorded trend',text:`From ${label(rows[first])} to ${label(rows[last])}, ${metric.replaceAll('_',' ')} ${movement} from ${shown(first)} to ${shown(last)}${scope}.`}];
  }
  const highest=values.indexOf(Math.max(...values));
  const lowest=values.indexOf(Math.min(...values));
  const facts=[{title:'Largest recorded group',text:`${label(rows[highest])}: ${shown(highest)}${scope}.`}];
  if(lowest!==highest)facts.push({title:'Smallest recorded group',
    text:`${label(rows[lowest])}: ${shown(lowest)}${scope}.`});
  return facts;
}

module.exports={observations};
