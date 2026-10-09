'use strict';

// Observations are derived only from the already-authorized report rows.
// They describe recorded differences; they never infer causes or invent forecasts.
function observations(result){
  const groups=result?.config?.groups||[],rows=result?.rows||[],columns=result?.columns||[];
  if(result?.comparisonSafe===false||!groups.length||rows.length<2||!columns.length)return [];
  const metric=result.chartColumn||columns.at(-1);
  if(rows.some((row)=>row[metric]===null||row[metric]===undefined))return [];
  const values=rows.map((row)=>Number(row[metric]));
  if(values.some((value)=>!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER))return [];
  const label=(row)=>groups.map((field)=>String(row[field]??'Not recorded')).join(' · ');
  const shown=(index)=>String(result.displayRows?.[index]?.[metric]??rows[index][metric]);
  const metricLabel=result.columnLabels?.[metric]||metric.replaceAll('_',' ');
  const scope=result.hasMore?' among the displayed groups':'';
  if(result.config.chart==='line'&&groups.length===1){
    const first=0,last=rows.length-1;
    const movement=values[last]>values[first]?'rose':values[last]<values[first]?'fell':'stayed the same';
    const facts=[{title:'Recorded trend',text:`From ${label(rows[first])} to ${label(rows[last])}, ${metricLabel} ${movement} from ${shown(first)} to ${shown(last)}${scope}.`}];
    if(rows.length>=3){
      const changes=values.slice(1).map((value,index)=>({index:index+1,change:value-values[index]}));
      const largest=changes.reduce((best,current)=>Math.abs(current.change)>Math.abs(best.change)?current:best);
      if(largest.change!==0)facts.push({title:'Largest recorded interval change',
        text:`From ${label(rows[largest.index-1])} to ${label(rows[largest.index])}, ${metricLabel} ${largest.change>0?'increased':'decreased'} from ${shown(largest.index-1)} to ${shown(largest.index)}${scope}.`});
    }
    return facts;
  }
  const highest=values.indexOf(Math.max(...values));
  const lowest=values.indexOf(Math.min(...values));
  const facts=[{title:'Largest recorded group',text:`${label(rows[highest])}: ${shown(highest)}${scope}.`}];
  if(lowest!==highest)facts.push({title:'Smallest recorded group',
    text:`${label(rows[lowest])}: ${shown(lowest)}${scope}.`});
  const belowZero=values.filter((value)=>value<0).length;
  if(belowZero)facts.push({title:'Negative recorded values',
    text:`${belowZero} displayed ${belowZero===1?'group has':'groups have'} a ${metricLabel} below zero${scope}.`});
  return facts;
}

module.exports={observations};
