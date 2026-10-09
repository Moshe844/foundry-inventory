'use strict';

const registry=require('./postgres-registry');
const permissions=require('../actions/permissions');
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const OPERATORS=new Set(['equals','contains','at_least','at_most','after','before','is_null']);
const AGGREGATES=new Set(['count','sum','average','minimum','maximum']);
const AGGREGATE_COLUMN=Object.freeze({count:'count',sum:'total',average:'average',minimum:'minimum',maximum:'maximum'});
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
  const datasetKey=safeText(spec?.dataset,60);
  const dataset=registry.get(datasetKey);if(!dataset)invalid('Choose an available report dataset.');
  ensureActor(actor,dataset);
  const columns=fieldList(spec.columns,dataset.fields,12);
  const groups=fieldList(spec.groups,dataset.fields,3);
  if(!columns.length&&!groups.length)invalid('Choose at least one column or grouping.');
  const aggregate=AGGREGATES.has(spec.aggregate)?spec.aggregate:'count';
  const measure=safeText(spec.measure,60);
  if(aggregate!=='count'&&(!Object.hasOwn(dataset.fields,measure)
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
  if(groups.length&&aggregate!=='count'&&dataset.fields[measure]==='money_minor'
    &&(!Object.hasOwn(dataset.fields,'currency')||(!groups.includes('currency')&&!exactCurrency)))
    invalid('Group monetary totals by currency or filter to one exact currency.');
  if(!groups.length&&columns.some((field)=>dataset.fields[field]==='money_minor')
    &&Object.hasOwn(dataset.fields,'currency')&&!columns.includes('currency')){
    if(columns.length>=12)invalid('Include currency with monetary columns; remove another column first.');
    columns.push('currency');
  }
  const sort=safeText(spec.sort,60)||groups[0]||columns[0]||'count';
  const allowedSort=new Set(groups.length?[...groups,AGGREGATE_COLUMN[aggregate]]:columns);
  if(!allowedSort.has(sort))invalid('Choose a displayed field to sort.');
  const direction=spec.direction==='asc'?'asc':'desc';
  const chart=['table','bar','line'].includes(spec.chart)?spec.chart:'table';
  if(chart!=='table'&&!groups.length)invalid('Choose a grouping before drawing a chart.');
  if(chart==='line'&&(groups.length!==1||dataset.fields[groups[0]]!=='date'||sort!==groups[0]
    ||direction!=='asc'))invalid('A trend line needs one date grouping sorted oldest to newest.');
  const title=safeText(spec.title,100)||dataset.label;
  return {dataset:datasetKey,columns:groups.length?[]:columns,groups,aggregate,
    measure:aggregate==='count'?'':measure,filters:cleanFilters,sort,direction,chart,title};
}
function quote(field){return `"${field}"`;}
function condition(filter,index){
  const field=quote(filter.field),value=`$${index}`;
  if(filter.operator==='is_null')return `${field} IS NULL`;
  if(filter.operator==='equals')return `${field}=${value}`;
  if(filter.operator==='contains')return `${field} ILIKE '%'||${value}||'%'`;
  if(filter.operator==='at_least'||filter.operator==='after')return `${field}>=${value}`;
  return `${field}<=${value}`;
}
function queryFor(config,workspaceId,{limit=201,offset=0}={}){
  const dataset=registry.get(config.dataset);const values=[workspaceId];
  const clauses=config.filters.map((filter)=>{if(filter.operator!=='is_null')values.push(filter.value);
    return condition(filter,values.length);});
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  let select,group='';
  if(config.groups.length){
    const groupFields=config.groups.map(quote);const expression=config.aggregate==='count'?'COUNT(*)::bigint':
      config.aggregate==='sum'?`SUM(${quote(config.measure)})`:
        config.aggregate==='average'?`AVG(${quote(config.measure)})`:
          config.aggregate==='minimum'?`MIN(${quote(config.measure)})`:`MAX(${quote(config.measure)})`;
    select=`${groupFields.join(',')},${expression} AS ${quote(AGGREGATE_COLUMN[config.aggregate])}`;
    group=`GROUP BY ${groupFields.join(',')}`;
  }else select=`record_id,${config.columns.map(quote).join(',')}`;
  const direction=config.direction==='asc'?'ASC':'DESC';
  values.push(limit,offset);
  const sql=`WITH source AS (${dataset.source}) SELECT ${select} FROM source ${where} ${group}
    ORDER BY ${quote(config.sort)} ${direction} NULLS LAST
    LIMIT $${values.length-1} OFFSET $${values.length}`;
  return {sql,values};
}
async function run(database,ctx,actor,spec,options={}){
  const config=normalize(spec,actor);const limit=Math.min(5001,Math.max(1,Number(options.limit)||201));
  const dataset=registry.get(config.dataset);
  if(dataset.commercialCapability){const entitlements=require('../commercial/entitlements');
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    await entitlements.assertCapability(database,scope,dataset.commercialCapability,{allowReadOnly:true});}
  const offset=Math.max(0,Number(options.offset)||0);
  const {sql,values}=queryFor(config,ctx.workspaceId,{limit,offset});
  const rows=(await database.transaction((client)=>client.query(sql,values),
    {isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:10000,lockTimeoutMs:2000})).rows;
  if(config.groups.includes('currency')&&config.aggregate!=='count'&&dataset.fields[config.measure]==='money_minor'
    &&rows.some((row)=>!row.currency))invalid('A monetary row has no verified currency; its total cannot be certified.');
  const grouped=Boolean(config.groups.length);
  const columns=grouped?[...config.groups,AGGREGATE_COLUMN[config.aggregate]]
    :config.columns;
  const currencyFilter=config.filters.find((filter)=>filter.field==='currency'
    &&filter.operator==='equals')?.value||null;
  const monetaryColumn=(column)=>grouped
    ?column===columns.at(-1)&&config.aggregate!=='count'&&dataset.fields[config.measure]==='money_minor'
    :dataset.fields[column]==='money_minor';
  const displayRows=rows.map((row)=>Object.fromEntries(columns.map((column)=>{
    const value=row[column];if(!monetaryColumn(column)||value==null)return [column,value];
    const currency=row.currency||currencyFilter;
    return [column,currency?require('../pricing/postgres-service').formatMinor(value,currency):
      `${value} minor units (currency not recorded)`];
  })));
  return {config,columns,rows:rows.map((row)=>({...row,
    href:grouped?null:dataset.recordHref(row)})),displayRows,
  hasMore:rows.length===limit,asOf:new Date().toISOString(),
  provenance:{dataset:config.dataset,workspaceId:ctx.workspaceId,source:'PostgreSQL',grouped,
    currency:currencyFilter}};
}
function drilldownSpec(spec,values,actor){
  const config=normalize(spec,actor);
  if(!config.groups.length)invalid('Only a grouped report can be drilled into.');
  if(!Array.isArray(values)||values.length!==config.groups.length)invalid('Choose one exact report group.');
  if(config.filters.length+values.length>12)invalid('This report has too many filters for a safe drill-down.');
  const dataset=registry.get(config.dataset);
  const columns=[...new Set([...config.groups,...Object.keys(dataset.fields)])].slice(0,12);
  return normalize({...config,title:`${config.title} - source records`,groups:[],columns,
    filters:[...config.filters,...config.groups.map((field,index)=>({field,
      operator:values[index]==null?'is_null':'equals',value:safeText(values[index],120)}))],
    sort:config.groups[0],chart:'table'},actor);
}
async function save(database,ctx,actor,spec,{id=null,schedule=null}={}){
  const config=normalize(spec,actor);const delivery=schedule||{};
  const frequency=['none','daily','weekly'].includes(delivery.frequency)?delivery.frequency:'none';
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

module.exports={normalize,queryFor,run,save,list,load,drilldownSpec};
