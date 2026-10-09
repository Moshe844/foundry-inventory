'use strict';

const registry=require('./postgres-registry');
const composed=require('./postgres-composed');
const permissions=require('../actions/permissions');
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const OPERATORS=new Set(['equals','contains','at_least','at_most','after','before','is_null']);
const AGGREGATES=new Set(['count','sum','average','minimum','maximum','ratio']);
const DATE_GRAINS=new Set(['exact','day','week','month','quarter','year']);
const AGGREGATE_COLUMN=Object.freeze({count:'count',sum:'total',average:'average',minimum:'minimum',maximum:'maximum',ratio:'ratio'});
function invalid(message){throw new ValidationError(message);}
function ensureActor(actor,dataset){permissions.assertCan(actor,dataset.permission,'view this report');}
function safeText(value,max=120){const text=String(value??'').trim();if(text.length>max)invalid('A report value is too long.');return text;}
function fieldList(value,fields,maximum){
  const values=Array.isArray(value)?value:typeof value==='string'?value.split(','):[];
  const names=[...new Set(values.map((entry)=>safeText(entry,60)).filter(Boolean))];
  if(names.length>maximum||names.some((field)=>!Object.hasOwn(fields,field)))invalid('Choose registered report fields only.');
  return names;
}
function normalize(spec,actor){
  spec=spec||{};
  if(spec.dataset==='composed')return composed.normalize(spec,actor);
  const datasetKey=safeText(spec?.dataset,60);
  const dataset=registry.get(datasetKey);if(!dataset)invalid('Choose an available report dataset.');
  ensureActor(actor,dataset);
  const columns=fieldList(spec.columns,dataset.fields,12);
  const groups=fieldList(spec.groups,dataset.fields,3);
  const summary=spec.summary===true;
  const dateGrain=DATE_GRAINS.has(spec.dateGrain)?spec.dateGrain:'exact';
  if(dateGrain!=='exact'&&!groups.some((field)=>dataset.fields[field]==='date'))
    invalid('Choose a date grouping before selecting a date interval.');
  if(!columns.length&&!groups.length&&!summary)invalid('Choose columns, grouping, or a whole-dataset summary.');
  const aggregate=AGGREGATES.has(spec.aggregate)?spec.aggregate:'count';
  const measure=safeText(spec.measure,60);
  const metric=dataset.metrics?.[measure];
  if(aggregate==='ratio'&&(!metric||metric.kind!=='ratio'
    ||!['number','money_minor'].includes(dataset.fields[metric.numerator])
    ||!['number','money_minor'].includes(dataset.fields[metric.denominator])))
    invalid('Choose a registered weighted ratio.');
  if(aggregate!=='count'&&aggregate!=='ratio'&&(!Object.hasOwn(dataset.fields,measure)
    ||!['number','money_minor'].includes(dataset.fields[measure])))invalid('Choose a numeric measure.');
  const filters=Array.isArray(spec.filters)?spec.filters:[];
  if(filters.length>12)invalid('Use at most twelve filters.');
  const cleanFilters=filters.map((filter)=>{
    const field=safeText(filter.field,60),operator=safeText(filter.operator,30),value=safeText(filter.value);
    if(!Object.hasOwn(dataset.fields,field)||!OPERATORS.has(operator)||(!value&&operator!=='is_null'))
      invalid('Choose valid report filters.');
    const type=dataset.fields[field];
    if(['at_least','at_most'].includes(operator)&&!['number','money_minor','date'].includes(type))
      invalid('This field cannot be compared numerically.');
    if(['after','before'].includes(operator)&&type!=='date')invalid('This field is not a date.');
    if(operator==='contains'&&type!=='text')invalid('Only text fields support contains.');
    if(operator!=='is_null'&&type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(value))
      invalid('Use dates in YYYY-MM-DD format.');
    if(operator!=='is_null'&&['number','money_minor'].includes(type)&&!Number.isFinite(Number(value)))
      invalid('Use a valid numeric filter.');
    return {field,operator,value};
  });
  const exactCurrency=cleanFilters.find((filter)=>filter.field==='currency'
    &&filter.operator==='equals'&&/^[A-Z]{3}$/u.test(filter.value));
  const aggregated=Boolean(groups.length||summary);
  const completeness=aggregated&&aggregate!=='count'&&aggregate!=='ratio'
    ?dataset.moneyCompleteness?.[measure]:null;
  if(completeness&&!cleanFilters.some((filter)=>filter.field===completeness.field
    &&filter.operator==='equals'&&filter.value===completeness.value))
    invalid(`This amount is not known for every record. Filter ${completeness.field.replaceAll('_',' ')} to ${completeness.value} before calculating a total.`);
  if(aggregated&&aggregate!=='count'&&dataset.fields[measure]==='money_minor'
    &&(!Object.hasOwn(dataset.fields,'currency')||(!groups.includes('currency')&&!exactCurrency)))
    invalid('Group monetary totals by currency or filter to one exact currency.');
  if(aggregated&&aggregate==='ratio'&&metric.currencySensitive
    &&(!groups.includes('currency')&&!exactCurrency))
    invalid('Filter this monetary ratio to one exact currency or group by currency.');
  if(!aggregated&&columns.some((field)=>dataset.fields[field]==='money_minor')
    &&Object.hasOwn(dataset.fields,'currency')&&!columns.includes('currency')){
    if(columns.length>=12)invalid('Include currency with monetary columns; remove another column first.');
    columns.push('currency');
  }
  const sort=safeText(spec.sort,60)||groups[0]||(summary?AGGREGATE_COLUMN[aggregate]:columns[0]);
  const allowedSort=new Set(aggregated?[...groups,AGGREGATE_COLUMN[aggregate]]:Object.keys(dataset.fields));
  if(!allowedSort.has(sort))invalid('Choose a registered field to sort.');
  const direction=spec.direction==='asc'?'asc':'desc';
  const chart=['table','bar','line'].includes(spec.chart)?spec.chart:'table';
  if(chart!=='table'&&!groups.length)invalid('Choose a grouping before drawing a chart.');
  if(chart==='line'&&(groups.length!==1||dataset.fields[groups[0]]!=='date'||sort!==groups[0]
    ||direction!=='asc'))invalid('A trend line needs one date grouping sorted oldest to newest.');
  const title=safeText(spec.title,100)||dataset.label;
  const layout=['chart_first','table_first','dashboard'].includes(spec.layout)?spec.layout:'chart_first';
  return {dataset:datasetKey,columns:aggregated?[]:columns,groups,summary:summary&&!groups.length,dateGrain,aggregate,
    measure:aggregate==='count'?'':measure,filters:cleanFilters,sort,direction,chart,layout,title};
}
function quote(field){return `"${field}"`;}
function comparableGroupAmounts(config,dataset,rows,hasMore,currencyFilter){
  if(!config.groups.length||config.aggregate==='count'||dataset.fields[config.measure]!=='money_minor'
    ||currencyFilter)return true;
  return !hasMore&&new Set(rows.map((row)=>row.currency)).size<=1;
}
function condition(filter,index){
  const field=quote(filter.field),value=`$${index}`;
  if(filter.operator==='is_null')return `${field} IS NULL`;
  if(filter.operator==='equals')return `${field}=${value}`;
  if(filter.operator==='contains')return `${field} ILIKE ${value} ESCAPE '!'`;
  if(filter.operator==='at_least'||filter.operator==='after')return `${field}>=${value}`;
  return `${field}<=${value}`;
}
function filterParameter(filter){
  return filter.operator==='contains'
    ?`%${filter.value.replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')}%`
    :filter.value;
}
function queryFor(config,workspaceId,{limit=201,offset=0}={}){
  const dataset=registry.get(config.dataset);const values=[workspaceId];
  const clauses=config.filters.map((filter)=>{if(filter.operator!=='is_null')values.push(filterParameter(filter));
    return condition(filter,values.length);});
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  let select,group='';
  if(config.groups.length||config.summary){
    const groupFields=config.groups.map((field)=>config.dateGrain!=='exact'&&dataset.fields[field]==='date'
      ?`date_trunc('${config.dateGrain}',${quote(field)}::timestamp)::date`:quote(field));
    const selectGroups=groupFields.map((expression,index)=>{
      const field=config.groups[index];
      return config.dateGrain!=='exact'&&dataset.fields[field]==='date'
        ?`to_char(${expression},'YYYY-MM-DD') AS ${quote(field)}`
        :`${expression} AS ${quote(field)}`;
    });
    const metric=dataset.metrics?.[config.measure];
    const expression=config.aggregate==='count'?'COUNT(*)::bigint':
      config.aggregate==='ratio'
        ?`ROUND(100.0*SUM(${quote(metric.numerator)})::numeric/NULLIF(SUM(${quote(metric.denominator)}),0),2)`:
      config.aggregate==='sum'?`SUM(${quote(config.measure)})`:
        config.aggregate==='average'?`AVG(${quote(config.measure)})`:
          config.aggregate==='minimum'?`MIN(${quote(config.measure)})`:`MAX(${quote(config.measure)})`;
    select=`${selectGroups.length?`${selectGroups.join(',')},`:''}${expression} AS ${quote(AGGREGATE_COLUMN[config.aggregate])}`;
    group=groupFields.length?`GROUP BY ${groupFields.join(',')}`:'';
  }else select=`record_id,${config.columns.map(quote).join(',')}`;
  const direction=config.direction==='asc'?'ASC':'DESC';
  const tieBreakers=config.groups.length?config.groups.map(quote):config.summary?[]:
    ['record_id',...Object.keys(dataset.fields)].map(quote);
  const stableOrder=[`${quote(config.sort)} ${direction} NULLS LAST`,
    ...tieBreakers.filter((field)=>field!==quote(config.sort)).map((field)=>`${field} ASC NULLS LAST`)];
  values.push(limit,offset);
  const sql=`WITH source AS (${dataset.source}) SELECT ${select} FROM source ${where} ${group}
    ORDER BY ${stableOrder.join(',')}
    LIMIT $${values.length-1} OFFSET $${values.length}`;
  return {sql,values};
}
async function run(database,ctx,actor,spec,options={}){
  if(spec?.dataset==='composed')return composed.run(database,ctx,actor,spec,options);
  const config=normalize(spec,actor);const limit=Math.min(20001,Math.max(2,Number(options.limit)||201));
  const dataset=registry.get(config.dataset);
  if(dataset.commercialCapability){const entitlements=require('../commercial/entitlements');
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    await entitlements.assertCapability(database,scope,dataset.commercialCapability,{allowReadOnly:true});}
  const suppliedOffset=Number(options.offset)||0;
  if(!Number.isSafeInteger(suppliedOffset)||suppliedOffset<0||suppliedOffset>1000000)
    invalid('That report page is unavailable. Narrow the filters before browsing further.');
  const offset=suppliedOffset;
  const {sql,values}=queryFor(config,ctx.workspaceId,{limit,offset});
  const fetched=(await database.transaction((client)=>client.query(sql,values),
    {isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:10000,lockTimeoutMs:2000})).rows;
  const hasMore=fetched.length===limit;
  const rows=hasMore?fetched.slice(0,-1):fetched;
  if(config.groups.includes('currency')&&config.aggregate!=='count'&&dataset.fields[config.measure]==='money_minor'
    &&rows.some((row)=>!row.currency))invalid('A monetary row has no verified currency; its total cannot be certified.');
  const grouped=Boolean(config.groups.length||config.summary);
  const columns=grouped?[...config.groups,AGGREGATE_COLUMN[config.aggregate]]
    :config.columns;
  const columnLabels=config.aggregate==='ratio'&&grouped
    ?{ratio:dataset.metrics[config.measure].label}:{};
  const currencyFilter=config.filters.find((filter)=>filter.field==='currency'
    &&filter.operator==='equals')?.value||null;
  const monetaryColumn=(column)=>grouped
    ?column===columns.at(-1)&&config.aggregate!=='count'&&dataset.fields[config.measure]==='money_minor'
    :dataset.fields[column]==='money_minor';
  const displayRows=rows.map((row)=>Object.fromEntries(columns.map((column)=>{
    const value=row[column];
    if(grouped&&config.aggregate==='ratio'&&column===columns.at(-1))
      return [column,value==null?'Not calculable':`${Number(value).toFixed(2)}%`];
    if(!monetaryColumn(column)||value==null)return [column,value];
    const currency=row.currency||currencyFilter;
    return [column,currency?require('../pricing/postgres-service').formatMinor(value,currency):
      `${value} minor units (currency not recorded)`];
  })));
  const output={config,columns,columnLabels,rows:rows.map((row)=>({...row,
    href:grouped?null:dataset.recordHref(row)})),displayRows,
  hasMore,offset,pageSize:limit-1,asOf:new Date().toISOString(),
  provenance:{dataset:config.dataset,workspaceId:ctx.workspaceId,source:'PostgreSQL',grouped,
    currency:currencyFilter}};
  // Totals from different currencies are individually valid, but their raw minor
  // units cannot be ranked or plotted on one numeric scale.
  output.comparisonSafe=comparableGroupAmounts(config,dataset,rows,output.hasMore,currencyFilter);
  output.insights=require('./postgres-insights').observations(output);
  return output;
}
async function countAtMost(database,ctx,actor,spec,maximum){
  if(spec?.dataset==='composed')return composed.countAtMost(database,ctx,actor,spec,maximum);
  const config=normalize(spec,actor),dataset=registry.get(config.dataset);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)
    invalid('That export size is unavailable.');
  if(dataset.commercialCapability){const entitlements=require('../commercial/entitlements');
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    await entitlements.assertCapability(database,scope,dataset.commercialCapability,{allowReadOnly:true});}
  if(config.summary)return 1;
  const values=[ctx.workspaceId];
  const clauses=config.filters.map((filter)=>{if(filter.operator!=='is_null')values.push(filterParameter(filter));
    return condition(filter,values.length);});
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const groups=config.groups.map((field)=>config.dateGrain!=='exact'&&dataset.fields[field]==='date'
    ?`date_trunc('${config.dateGrain}',${quote(field)}::timestamp)::date`:quote(field));
  values.push(maximum+1);
  const sql=`WITH source AS (${dataset.source}) SELECT COUNT(*)::bigint AS count FROM (
    SELECT 1 FROM source ${where} ${groups.length?`GROUP BY ${groups.join(',')}`:''}
    LIMIT $${values.length}) bounded`;
  const row=(await database.transaction((client)=>client.query(sql,values),
    {isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:20000,lockTimeoutMs:2000})).rows[0];
  return Number(row.count);
}
function drilldownSpec(spec,values,actor,sourceAlias=null){
  if(spec?.dataset==='composed')return composed.drilldownSpec(spec,values,actor,sourceAlias);
  const config=normalize(spec,actor);
  if(!config.groups.length&&!config.summary)invalid('Only a summarized report can be drilled into.');
  if(!Array.isArray(values)||values.length!==config.groups.length)invalid('Choose one exact report group.');
  const dataset=registry.get(config.dataset);
  const columns=[...new Set([...config.groups,...Object.keys(dataset.fields)])].slice(0,12);
  const groupFilters=config.groups.flatMap((field,index)=>{
    const value=values[index];
    if(value==null)return [{field,operator:'is_null',value:''}];
    if(config.dateGrain==='exact'||dataset.fields[field]!=='date')
      return [{field,operator:'equals',value:safeText(value,120)}];
    const start=new Date(`${safeText(value,10)}T00:00:00.000Z`);
    if(!Number.isFinite(start.valueOf())||start.toISOString().slice(0,10)!==value)
      invalid('Choose one exact date group.');
    const end=new Date(start);
    if(config.dateGrain==='day')end.setUTCDate(end.getUTCDate()+1);
    else if(config.dateGrain==='week')end.setUTCDate(end.getUTCDate()+7);
    else if(config.dateGrain==='month')end.setUTCMonth(end.getUTCMonth()+1);
    else if(config.dateGrain==='quarter')end.setUTCMonth(end.getUTCMonth()+3);
    else end.setUTCFullYear(end.getUTCFullYear()+1);
    end.setUTCDate(end.getUTCDate()-1);
    return [{field,operator:'at_least',value:start.toISOString().slice(0,10)},
      {field,operator:'at_most',value:end.toISOString().slice(0,10)}];
  });
  if(config.filters.length+groupFilters.length>12)
    invalid('This report has too many filters for a safe drill-down.');
  return normalize({...config,title:`${config.title} - source records`,groups:[],summary:false,
    aggregate:'count',measure:'',dateGrain:'exact',columns,
    filters:[...config.filters,...groupFilters],sort:config.groups[0]||columns[0],chart:'table'},actor);
}
async function save(database,ctx,actor,spec,{id=null,schedule=null}={}){
  const config=normalize(spec,actor);const delivery=schedule||{};
  const frequency=['none','daily','weekly'].includes(delivery.frequency)?delivery.frequency:'none';
  if(frequency!=='none'&&(delivery.hour==null||delivery.hour===''||!Number.isInteger(Number(delivery.hour))
    ||Number(delivery.hour)<0||Number(delivery.hour)>23))invalid('Choose a UTC delivery hour from 0 to 23.');
  const hour=Number.isInteger(Number(delivery.hour))&&Number(delivery.hour)>=0&&Number(delivery.hour)<24
    ?Number(delivery.hour):9;
  const recipient=safeText(delivery.recipient,200);
  if(frequency!=='none'&&(!recipient||!actor.email||recipient.toLowerCase()!==actor.email.toLowerCase()))
    invalid('Scheduled reports can only be delivered to your verified account email.');
  const reportId=id||newId('report');
  const result=await database.query(`INSERT INTO stockchief_runtime.report_templates
      (id,workspace_id,owner_user_id,title,definition,schedule_frequency,schedule_hour_utc,
       delivery_email,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,now(),now())
      ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,definition=EXCLUDED.definition,
        schedule_frequency=EXCLUDED.schedule_frequency,schedule_hour_utc=EXCLUDED.schedule_hour_utc,
        delivery_email=EXCLUDED.delivery_email,updated_at=now()
      WHERE stockchief_runtime.report_templates.workspace_id=EXCLUDED.workspace_id
        AND stockchief_runtime.report_templates.owner_user_id=EXCLUDED.owner_user_id
      RETURNING *`,[reportId,ctx.workspaceId,ctx.actorId,config.title,JSON.stringify(config),
      frequency,hour,frequency==='none'?null:recipient||null]);
  if(!result.rows[0])invalid('That report template is not yours to edit.');
  return result.rows[0];
}
async function list(database,ctx,actor){
  const rows=(await database.query(`SELECT id,title,definition,schedule_frequency,schedule_hour_utc,
      delivery_email,last_delivered_at,last_error,updated_at
      FROM stockchief_runtime.report_templates WHERE workspace_id=$1 AND owner_user_id=$2
      ORDER BY updated_at DESC LIMIT 100`,[ctx.workspaceId,ctx.actorId])).rows;
  return rows.filter((row)=>{try{normalize(row.definition,actor);return true;}catch{return false;}});
}
async function load(database,ctx,actor,id){
  const row=(await database.query(`SELECT * FROM stockchief_runtime.report_templates
    WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row)invalid('That saved report is unavailable.');
  return {...row,definition:normalize(row.definition,actor)};
}

module.exports={normalize,queryFor,run,countAtMost,save,list,load,drilldownSpec,comparableGroupAmounts,
  aggregateColumn:AGGREGATE_COLUMN};
