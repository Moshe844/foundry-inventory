'use strict';

const registry=require('./postgres-registry');
const composed=require('./postgres-composed');
const permissions=require('../actions/permissions');
const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const OPERATORS=new Set(['equals','is_not','contains','greater_than','less_than','at_least','at_most','after','before','is_null','is_empty','not_empty','relative']);
const AGGREGATES=new Set(['count','count_distinct','sum','average','minimum','maximum','ratio']);
const DATE_GRAINS=new Set(['exact','day','week','month','quarter','year']);
const AGGREGATE_COLUMN=Object.freeze({count:'count',count_distinct:'distinct_count',sum:'total',average:'average',minimum:'minimum',maximum:'maximum',ratio:'ratio'});
// The native tool shares this grammar. Dataset fields, permissions, money
// completeness and currency rules remain owned by queryContract.
const querySyntax=Object.freeze({operators:Object.freeze([...OPERATORS]),aggregates:Object.freeze([...AGGREGATES]),
 dateGrains:Object.freeze([...DATE_GRAINS])});
// Discovery and execution share the same registered fields and validator enums.
function queryContract(key,actor){
 if(key==='composed')return composed.queryContract(actor);
 const dataset=registry.get(key);
 if(!dataset||!permissions.can(actor,dataset.permission))return null;
 const fields=Object.keys(dataset.fields),field={type:'string',enum:fields};
 return {schema:{type:'object',additionalProperties:false,required:['dataset'],properties:{
  dataset:{const:key},columns:{type:'array',maxItems:fields.length,items:field},groups:{type:'array',maxItems:3,items:field},
  summary:{type:'boolean'},aggregate:{enum:[...AGGREGATES]},measure:{enum:['',...fields,...Object.keys(dataset.metrics||{})]},dateGrain:{enum:[...DATE_GRAINS]},
  filters:{type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['field','operator'],properties:{
   field,operator:{enum:[...OPERATORS]},value:{type:['string','number','boolean']}}}},
  sort:{type:'string',enum:[...fields,...Object.values(AGGREGATE_COLUMN)]},direction:{enum:['asc','desc']},
  topN:{type:'integer',minimum:1,maximum:1000},
  chart:{enum:['table','bar','line']},layout:{enum:['chart_first','table_first','dashboard']},title:{type:'string',maxLength:100}
 }},filterValues:dataset.filterValues||{},rules:['Choose columns, groups, or summary:true. Grouped and whole-dataset summaries require a valid aggregate and numeric measure except count.',
  'Text equality is case-sensitive. Use the exact registered filterValues codes where supplied; other values are rejected rather than reported as an empty population.',
  'Absolute date filters use YYYY-MM-DD; relative periods resolve in the business time zone on each run. Contains requires text; date and numeric comparisons use registered fields; empty also recognizes an empty text value.',
  'Money is in minor currency units. Monetary aggregation requires an exact currency filter or currency grouping, and any registered completeness filter.',
  'Sort grouped results by a group field or aggregate output name. Sorting by the primary measure means its calculated aggregate, unless that measure is itself a group field.'],
  fields:dataset.fields,metrics:dataset.metrics||{},moneyCompleteness:dataset.moneyCompleteness||{}};
}
function invalid(message){throw new ValidationError(message);}
function ensureActor(actor,dataset){permissions.assertCan(actor,dataset.permission,'view this report');}
function safeText(value,max=120){const text=String(value??'').trim();if(text.length>max)invalid('A report value is too long.');return text;}
function fieldList(value,fields,maximum){
  const values=Array.isArray(value)?value:typeof value==='string'?value.split(','):[];
  const names=[...new Set(values.map((entry)=>safeText(entry,60)).filter(Boolean))];
  if(names.length>maximum||names.some((field)=>!Object.hasOwn(fields,field)))invalid('Choose registered report fields only.');
  return names;
}
// A bounded inspection of an authorized dataset does not require the caller
// to discover and spell every display column first. Explicit report specs
// retain their existing strict validation and are never silently rewritten.
function inspectionSpec(spec,actor){
  if(!spec||spec.dataset==='composed'||Object.hasOwn(spec,'columns')||Object.hasOwn(spec,'groups')||spec.summary===true)return spec;
  const dataset=registry.get(spec.dataset);if(!dataset)invalid('Choose an available report dataset.');ensureActor(actor,dataset);
  const columns=Object.keys(dataset.fields).slice(0,12);
  if(Object.hasOwn(dataset.fields,'currency')&&!columns.includes('currency')){if(columns.length===12)columns.pop();columns.push('currency');}
  return {...spec,columns};
}
function normalize(spec,actor){
  spec=spec||{};
  if(spec.dataset==='composed')return composed.normalize(spec,actor);
  const datasetKey=safeText(spec?.dataset,60);
  const dataset=registry.get(datasetKey);if(!dataset)invalid('Choose an available report dataset.');
  ensureActor(actor,dataset);
  const columns=fieldList(spec.columns,dataset.fields,Object.keys(dataset.fields).length);
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
  if(aggregate==='count_distinct'&&!Object.hasOwn(dataset.fields,measure))
    invalid('Choose a registered field to count distinct values.');
  if(aggregate!=='count'&&aggregate!=='count_distinct'&&aggregate!=='ratio'&&(!Object.hasOwn(dataset.fields,measure)
    ||!['number','money_minor'].includes(dataset.fields[measure])))invalid('Choose a numeric measure.');
  const compare=['previous_period','previous_year'].includes(spec.compare)?spec.compare:'';
  const filters=Array.isArray(spec.filters)?spec.filters:[];
  if(filters.length>12)invalid('Use at most twelve filters.');
  const cleanFilters=filters.map((filter)=>{
    const field=safeText(filter.field,60),operator=safeText(filter.operator,30),value=safeText(filter.value);
    if(!Object.hasOwn(dataset.fields,field)||!OPERATORS.has(operator)||(!value&&!['is_null','is_empty','not_empty'].includes(operator)))
      invalid('Choose valid report filters.');
    const choices=dataset.filterValues?.[field];
    if(operator==='equals'&&choices&&!choices.includes(value))
      invalid(`Use an exact ${field} value: ${choices.join(', ')}.`);
    const type=dataset.fields[field];
    if(['at_least','at_most','greater_than','less_than'].includes(operator)&&!['number','money_minor','date'].includes(type))
      invalid('This field cannot be compared numerically.');
    if(['after','before'].includes(operator)&&type!=='date')invalid('This field is not a date.');
    if(operator==='contains'&&type!=='text')invalid('Only text fields support contains.');
    if(operator==='relative'&&(type!=='date'||!require('./relative-dates').normalize(value)))invalid('Choose a supported relative period for a date field.');
    if(!['is_null','is_empty','not_empty','relative'].includes(operator)&&type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(value))
      invalid('Use dates in YYYY-MM-DD format.');
    if(!['is_null','is_empty','not_empty'].includes(operator)&&['number','money_minor'].includes(type)&&!Number.isFinite(Number(value)))
      invalid('Use a valid numeric filter.');
    return {field,operator,value:operator==='relative'?require('./relative-dates').normalize(value):value};
  });
  const exactCurrency=cleanFilters.find((filter)=>filter.field==='currency'
    &&filter.operator==='equals'&&/^[A-Z]{3}$/u.test(filter.value));
  const aggregated=Boolean(groups.length||summary);
  const completeness=aggregated&&aggregate!=='count'&&aggregate!=='count_distinct'&&aggregate!=='ratio'
    ?dataset.moneyCompleteness?.[measure]:null;
  if(completeness&&!cleanFilters.some((filter)=>filter.field===completeness.field
    &&filter.operator==='equals'&&filter.value===completeness.value))
    invalid(`This amount is not known for every record. Filter ${completeness.field.replaceAll('_',' ')} to ${completeness.value} before calculating a total.`);
  if(aggregated&&!['count','count_distinct'].includes(aggregate)&&dataset.fields[measure]==='money_minor'
    &&(!Object.hasOwn(dataset.fields,'currency')||(!groups.includes('currency')&&!exactCurrency)))
    invalid('Group monetary totals by currency or filter to one exact currency.');
  if(aggregated&&aggregate==='ratio'&&metric.currencySensitive
    &&(!groups.includes('currency')&&!exactCurrency))
    invalid('Filter this monetary ratio to one exact currency or group by currency.');
  const extras=[];
  if(aggregated)for(const raw of Array.isArray(spec.extras)?spec.extras.slice(0,6):[]){
    const kind=AGGREGATES.has(raw?.aggregate)?raw.aggregate:'count',chosen=kind==='count'?'':safeText(raw?.measure,60),known=dataset.metrics?.[chosen];
    if(kind==='ratio'&&!known)invalid('Choose a registered weighted ratio.');
    if(kind==='count_distinct'&&!Object.hasOwn(dataset.fields,chosen))invalid('Choose a registered field to count distinct values.');
    if(!['count','count_distinct','ratio'].includes(kind)&&(!Object.hasOwn(dataset.fields,chosen)||!['number','money_minor'].includes(dataset.fields[chosen])))invalid('Choose a numeric measure.');
    const scope=!['count','count_distinct','ratio'].includes(kind)?dataset.moneyCompleteness?.[chosen]:null;
    if(scope&&!cleanFilters.some(filter=>filter.field===scope.field&&filter.operator==='equals'&&filter.value===scope.value))
      invalid(`This amount is not known for every record. Filter ${scope.field.replaceAll('_',' ')} to ${scope.value} before calculating a total.`);
    const moneyTotal=!['count','count_distinct','ratio'].includes(kind)&&dataset.fields[chosen]==='money_minor',moneyRatio=kind==='ratio'&&known?.currencySensitive;
    if((moneyTotal||moneyRatio)&&(!Object.hasOwn(dataset.fields,'currency')||(!groups.includes('currency')&&!exactCurrency)))
      invalid('Group monetary totals by currency or filter to one exact currency.');
    const extra={aggregate:kind,measure:chosen};
    if((kind===aggregate&&chosen===measure)||extras.some(item=>extraColumn(item)===extraColumn(extra)))continue;
    extras.push(extra);
  }
  if(!aggregated&&columns.some((field)=>dataset.fields[field]==='money_minor')
    &&Object.hasOwn(dataset.fields,'currency')&&!columns.includes('currency')){
    columns.push('currency');
  }
  const requestedLabels=spec.columnLabels&&typeof spec.columnLabels==='object'&&!Array.isArray(spec.columnLabels)
    ?spec.columnLabels:{};
  const extraNames=extras.map(extraColumn);
  const visibleColumns=new Set(aggregated?[...groups,AGGREGATE_COLUMN[aggregate],...extraNames]:columns);
  const columnLabels={};
  for(const [field,label] of Object.entries(requestedLabels)){
    if(!Object.hasOwn(dataset.fields,field)&&!Object.values(AGGREGATE_COLUMN).includes(field)&&!extraNames.includes(field))
      invalid('Rename only registered report columns.');
    if(!visibleColumns.has(field))continue;
    const clean=safeText(label,60);
    if(clean)columnLabels[field]=clean;
  }
  const requestedSort=safeText(spec.sort,60)||groups[0]||(summary?AGGREGATE_COLUMN[aggregate]:columns[0]);
  // The public contract accepts registered measure names. In a grouped result
  // that measure is represented by its aggregate output, not the source row.
  // Preserve explicit group-field sorting and reject every unrelated field.
  const sort=aggregated&&requestedSort===measure&&!groups.includes(measure)?AGGREGATE_COLUMN[aggregate]:requestedSort;
  const allowedSort=new Set(aggregated?[...groups,AGGREGATE_COLUMN[aggregate],...extraNames]:Object.keys(dataset.fields));
  if(!allowedSort.has(sort))invalid('Choose a registered field to sort.');
  const direction=spec.direction==='asc'?'asc':'desc';
  const topN=spec.topN==null||spec.topN===''?null:Number(spec.topN);
  if(topN!==null&&(!Number.isSafeInteger(topN)||topN<1||topN>1000))
    invalid('Choose a top or bottom count between 1 and 1,000.');
  const chart=['table','bar','line'].includes(spec.chart)?spec.chart:'table';
  if(chart!=='table'&&!groups.length)invalid('Choose a grouping before drawing a chart.');
  if(chart==='line'&&(groups.length!==1||dataset.fields[groups[0]]!=='date'||sort!==groups[0]
    ||direction!=='asc'))invalid('A trend line needs one date grouping sorted oldest to newest.');
  const title=safeText(spec.title,100)||dataset.label;
  const layout=['chart_first','table_first','dashboard'].includes(spec.layout)?spec.layout:'chart_first';
  const chartMeasure=extraNames.includes(spec.chartMeasure)?spec.chartMeasure:'';
  return {dataset:datasetKey,columns:aggregated?[]:columns,columnLabels,groups,summary:summary&&!groups.length,dateGrain,aggregate,
    measure:aggregate==='count'?'':measure,filters:cleanFilters,sort,direction,topN,chart,layout,title,
    ...(extras.length?{extras}:{}),...(chartMeasure?{chartMeasure}:{}),...(compare&&aggregated?{compare}:{})};
}
async function assertWritableCapabilities(database,ctx,spec,actor){
  const config=normalize(spec,actor);
  const sourceKeys=config.dataset==='composed'?config.metrics.map(metric=>metric.dataset):[config.dataset];
  const required=[...new Set(sourceKeys.map(key=>registry.get(key)?.commercialCapability).filter(Boolean))];
  if(config.dataset==='composed'){const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);if((await entitlements.subscriptionFor(database,scope.accountId))?.plan_configuration?.offerId)required.push('reports.advanced');}
  if(required.length){
    const entitlements=require('../commercial/entitlements');
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    for(const capability of required)await entitlements.assertCapability(database,scope,capability);
  }
  return config;
}
function quote(field){return `"${field}"`;}
// Further numbers beside the main one. A report can show sales, profit and units together.
const extraColumn=extra=>`${AGGREGATE_COLUMN[extra.aggregate]}_${extra.measure||'records'}`;
function metricColumns(config){return [AGGREGATE_COLUMN[config.aggregate],...(config.extras||[]).map(extraColumn)];}
function metricOf(config,column){return column===AGGREGATE_COLUMN[config.aggregate]?{aggregate:config.aggregate,measure:config.measure}:(config.extras||[]).find(extra=>extraColumn(extra)===column)||null;}
function metricExpression(dataset,aggregate,measure){
  const metric=dataset.metrics?.[measure];
  return aggregate==='count'?'COUNT(*)::bigint':
    aggregate==='count_distinct'?`COUNT(DISTINCT ${quote(measure)})::bigint`:
    aggregate==='ratio'
      ?`ROUND(100.0*SUM(${quote(metric.numerator)})::numeric/NULLIF(SUM(${quote(metric.denominator)}),0),2)`:
    aggregate==='sum'?`SUM(${quote(measure)})`:
      aggregate==='average'?(dataset.fields[measure]==='money_minor'?`ROUND(AVG(${quote(measure)})::numeric,0)`:`AVG(${quote(measure)})`):
        aggregate==='minimum'?`MIN(${quote(measure)})`:`MAX(${quote(measure)})`;
}
function metricLabel(dataset,aggregate,measure,fallback){
  const name=dataset.metrics?.[measure]?.label||(measure?require('./builder-entry').friendlyField(measure):'');
  if(aggregate==='ratio')return name;
  return {sum:name,average:'Average '+name.toLowerCase(),minimum:'Lowest '+name.toLowerCase(),maximum:'Highest '+name.toLowerCase(),count_distinct:'Different '+name.toLowerCase(),count:'Records'}[aggregate]||fallback;
}
function compareWindow(config,dateContext){
  if(!config.compare)return null;
  const resolved=require('./relative-dates').resolve(config,dateContext).filters,dataset=registry.get(config.dataset);
  const isFrom=filter=>['after','at_least'].includes(filter.operator),isTo=filter=>['before','at_most'].includes(filter.operator);
  const from=resolved.find(filter=>dataset.fields[filter.field]==='date'&&isFrom(filter));
  if(!from)return null;
  const to=resolved.find(filter=>filter.field===from.field&&isTo(filter))?.value||dateContext?.calendarDate;
  if(!to)return null;
  const day=value=>Date.parse(value+'T12:00:00Z'),text=ms=>new Date(ms).toISOString().slice(0,10);
  let previousFrom,previousTo;
  if(config.compare==='previous_year'){const back=value=>{const date=new Date(day(value));date.setUTCFullYear(date.getUTCFullYear()-1);return date.getTime();};previousFrom=text(back(from.value));previousTo=text(back(to));}
  else{const length=Math.round((day(to)-day(from.value))/86400000)+1;previousTo=text(day(from.value)-86400000);previousFrom=text(day(previousTo)-(length-1)*86400000);}
  const filters=[...resolved.filter(filter=>filter.field!==from.field||!(isFrom(filter)||isTo(filter))),{field:from.field,operator:'after',value:previousFrom},{field:from.field,operator:'before',value:previousTo}];
  return {field:from.field,from:from.value,to,previousFrom,previousTo,filters};
}
const changeBetween=(current,previous)=>{const now=Number(current),before=Number(previous);if(!Number.isFinite(now)||!Number.isFinite(before)||before===0)return null;return (now-before)/Math.abs(before)*100;};
const changeText=change=>change===null?'—':(change>0?'+':'')+change.toFixed(1)+'%';
function comparableGroupAmounts(config,dataset,rows,hasMore,currencyFilter){
  if(!config.groups.length||['count','count_distinct'].includes(config.aggregate)||dataset.fields[config.measure]!=='money_minor'
    ||currencyFilter)return true;
  return !hasMore&&new Set(rows.map((row)=>row.currency)).size<=1;
}
function condition(filter,index){
  const field=quote(filter.field),value=`$${index}`;
  if(filter.operator==='is_null')return `${field} IS NULL`;
  if(filter.operator==='is_empty')return filter.type==='text'?`(${field} IS NULL OR ${field}='')`:`${field} IS NULL`;
  if(filter.operator==='not_empty')return filter.type==='text'?`(${field} IS NOT NULL AND ${field}<>'')`:`${field} IS NOT NULL`;
  if(filter.operator==='equals')return `${field}=${value}`;
  if(filter.operator==='is_not')return `${field}<>${value}`;
  if(filter.operator==='contains')return `${field} ILIKE ${value} ESCAPE '!'`;
  if(filter.operator==='greater_than')return `${field}>${value}`;
  if(filter.operator==='less_than')return `${field}<${value}`;
  if(filter.operator==='at_least'||filter.operator==='after')return `${field}>=${value}`;
  return `${field}<=${value}`;
}
function filterParameter(filter){
  return filter.operator==='contains'
    ?`%${filter.value.replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')}%`
    :filter.value;
}
function queryFor(config,workspaceId,{limit=201,offset=0,dateContext=null,profitAccountIds=null}={}){
  config=require('./relative-dates').resolve(config,dateContext);
  const dataset=registry.get(config.dataset);const values=[workspaceId];
  const clauses=config.filters.map((filter)=>{if(!['is_null','is_empty','not_empty'].includes(filter.operator))values.push(filterParameter(filter));
    return dataset.filterAtSource?.(filter)?null:condition({...filter,type:dataset.fields[filter.field]},values.length);}).filter(Boolean);
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
    const expression=metricExpression(dataset,config.aggregate,config.measure);
    const extraSelects=(config.extras||[]).map(extra=>`,${metricExpression(dataset,extra.aggregate,extra.measure)} AS ${quote(extraColumn(extra))}`).join('');
    select=`${selectGroups.length?`${selectGroups.join(',')},`:''}${expression} AS ${quote(AGGREGATE_COLUMN[config.aggregate])}${extraSelects}`;
    group=groupFields.length?`GROUP BY ${groupFields.join(',')}`:'';
  }else{
    // SKU-level rows need a distinguishable product label even when the
    // author omitted the optional variant column. Product grouping and filters
    // still use the parent identity, so item totals never split by variant.
    const variantLabel=dataset.fields.variant&&config.columns.includes('sku')&&config.columns.includes('product')&&!config.columns.includes('variant');
    select=`record_id,${config.columns.map(field=>field==='product'&&variantLabel?`concat_ws(' — ',product,nullif(variant,'')) AS product`:quote(field)).join(',')}`;
  }
  const direction=config.direction==='asc'?'ASC':'DESC';
  const tieBreakers=config.groups.length?config.groups.map(quote):config.summary?[]:
    ['record_id',...Object.keys(dataset.fields)].map(quote);
  const stableOrder=[`${quote(config.sort)} ${direction} NULLS LAST`,
    ...tieBreakers.filter((field)=>field!==quote(config.sort)).map((field)=>`${field} ASC NULLS LAST`)];
  // A reviewed projection declares its fields and, when its row population
  // differs, its valid additive aggregates. Other counts, averages, filters
  // and groupings retain the full contributing-record source.
  const allMetrics=[{aggregate:config.aggregate,measure:config.measure},...(config.extras||[])];
  const needed=[...config.groups,...config.filters.map(f=>f.field),...allMetrics.flatMap(({aggregate,measure})=>{const metric=dataset.metrics?.[measure];return aggregate==='count'?[]:metric?[metric.numerator,metric.denominator]:[measure];})];
  const reduced=(config.groups.length||config.summary)&&[dataset.aggregateProjection,...(dataset.aggregateProjections||[])].filter(Boolean).find(p=>(!p.aggregates||allMetrics.every(({aggregate})=>p.aggregates.includes(aggregate)))&&(!p.filterFields||config.filters.every(f=>p.filterFields.includes(f.field)))&&(!p.groupFields||config.groups.every(f=>p.groupFields.includes(f)))&&needed.every(f=>p.fields.includes(f)));
  const rawSource=reduced?reduced.source:dataset.source;
  const transformed=dataset.sourceTransform?dataset.sourceTransform(rawSource,config):rawSource;
  const source=require('./postgres-profit-scope').bind(transformed,values,profitAccountIds);
  values.push(limit,offset);
  const sql=`WITH source AS (${source}) SELECT ${select} FROM source ${where} ${group}
    ORDER BY ${stableOrder.join(',')}
    LIMIT $${values.length-1} OFFSET $${values.length}`;
  return {sql,values};
}
async function run(database,ctx,actor,spec,options={}){
  if(spec?.dataset==='composed'){await assertWritableCapabilities(database,ctx,spec,actor);return composed.run(database,ctx,actor,spec,options);}
  const config=normalize(spec,actor);const limit=Math.min(20001,Math.max(2,Number(options.limit)||201));
  const dataset=registry.get(config.dataset);
  if(dataset.commercialCapability){const entitlements=require('../commercial/entitlements');
    const requestCache=require('../lib/request-read-cache'),scope=await requestCache.read(JSON.stringify(['report-owner',ctx.workspaceId]),()=>entitlements.ownerScopeForWorkspace(database,ctx.workspaceId));
    await requestCache.read(JSON.stringify(['report-permit',ctx.workspaceId,dataset.commercialCapability]),()=>entitlements.assertCapability(database,scope,dataset.commercialCapability,{allowReadOnly:true}));}
  const suppliedOffset=Number(options.offset)||0;
  if(!Number.isSafeInteger(suppliedOffset)||suppliedOffset<0||suppliedOffset>1000000)
    invalid('That report page is unavailable. Narrow the filters before browsing further.');
  const offset=suppliedOffset;
  const pageSize=limit-1;
  const allowed=config.topN===null?pageSize:Math.max(0,Math.min(pageSize,config.topN-offset));
  const queryLimit=allowed+((config.topN===null||offset+allowed<config.topN)?1:0);
  const dateContext=await require('../lib/request-read-cache').read(JSON.stringify(['report-clock',ctx.workspaceId]),()=>require('../lib/business-time').forWorkspace(database,ctx.workspaceId));
  const {sql,values}=queryFor(config,ctx.workspaceId,{limit:queryLimit,offset,dateContext});
  const fetched=await require('../lib/versioned-read-model').read(database,ctx.workspaceId,['report-rows',sql,values],async()=>(await database.transaction(async client=>{
    const profitAccountIds=await require('./postgres-profit-scope').accountIds(client,ctx.workspaceId,config);
    const query=queryFor(config,ctx.workspaceId,{limit:queryLimit,offset,dateContext,profitAccountIds});
    return client.query(query.sql,query.values);
  },{isolation:config.dataset==='profit_activity'?'REPEATABLE READ':'READ COMMITTED',readOnly:true,statementTimeoutMs:10000,lockTimeoutMs:2000,jit:false})).rows,{domain:['profit_activity','sales_order_lines','inventory_valuation','low_stock','movements','posted_sales_activity','supplier_bills','tax_activity','stock','catalogue','expenses','replenishment_rules','journal_lines','inventory_cost_movements','customers','sales_orders','purchase_orders','purchase_order_lines','supplier_items'].includes(config.dataset)?'business':'all'});
  const warnings=config.dataset==='movements'&&actor.role==='owner'
    ?await require('../lib/versioned-read-model').read(database,ctx.workspaceId,['movement-date-warnings'],()=>require('./postgres-movement-time').warnings(database,ctx.workspaceId),{domain:'business'}):[];
  const hasMore=fetched.length>allowed;
  const rows=fetched.slice(0,allowed);
  if(config.groups.includes('currency')&&!['count','count_distinct'].includes(config.aggregate)&&dataset.fields[config.measure]==='money_minor'
    &&rows.some((row)=>!row.currency))invalid('A monetary row has no verified currency; its total cannot be certified.');
  const grouped=Boolean(config.groups.length||config.summary);
  const metricNames=metricColumns(config);
  const columns=grouped?[...config.groups,...metricNames]
    :config.columns;
  const currencyFilter=config.filters.find((filter)=>filter.field==='currency'
    &&filter.operator==='equals')?.value||null;
  const monetaryColumn=(column)=>{
    if(!grouped)return dataset.fields[column]==='money_minor';
    const metric=metricOf(config,column);
    return Boolean(metric)&&!['count','count_distinct'].includes(metric.aggregate)&&dataset.fields[metric.measure]==='money_minor';
  };
  // The displayed monetary cells are formatted amounts, not raw minor units.
  // Derive headings from their declared type; retain raw field keys and values.
  const columnLabels=Object.fromEntries(columns.map(column=>{
    const metric=grouped?metricOf(config,column):null;
    if(metric?.aggregate==='ratio')return [column,dataset.metrics[metric.measure].label];
    const label=(monetaryColumn(column)?column.replace(/_minor$/,''):column).replaceAll('_',' ').replace(/([a-z])([A-Z])/g,'$1 $2');
    const plain=label.charAt(0).toUpperCase()+label.slice(1);
    return [column,config.columnLabels?.[column]||(metric?metricLabel(dataset,metric.aggregate,metric.measure,plain):require('./builder-entry').friendlyField(column))];
  }));
  const displayRows=rows.map((row)=>Object.fromEntries(columns.map((column)=>{
    const value=row[column];
    if(grouped&&metricOf(config,column)?.aggregate==='ratio')
      return [column,value==null?'Not calculable':`${Number(value).toFixed(2)}%`];
    if(!monetaryColumn(column)||value==null)return [column,value];
    const currency=row.currency||currencyFilter;
    return [column,currency?require('../pricing/postgres-service').formatMinor(value,currency):
      `${value} minor units (currency not recorded)`];
  })));
  const columnTypes=Object.fromEntries(columns.map(column=>[column,monetaryColumn(column)?'money_minor':grouped&&metricOf(config,column)?'number':dataset.fields[column]||'text']));const output={config,columns,columnLabels,columnTypes,rows:rows.map((row)=>({...row,
    href:grouped?null:dataset.recordHref(row)})),displayRows,
  hasMore,offset,pageSize,extent:{rowKind:grouped?'groups':'records',returnedRows:rows.length,
    totalRows:offset===0&&!hasMore?rows.length:null,complete:offset===0&&!hasMore},asOf:new Date().toISOString(),
  provenance:{dataset:config.dataset,workspaceId:ctx.workspaceId,source:'PostgreSQL',grouped,
    currency:currencyFilter}};
  // Totals from different currencies are individually valid, but their raw minor
  // units cannot be ranked or plotted on one numeric scale.
  output.warnings=warnings;
  output.comparisonSafe=comparableGroupAmounts(config,dataset,rows,output.hasMore,currencyFilter);
  const chartColumn=config.chartMeasure||(metricNames.length>1?metricNames[0]:null);
  if(grouped&&chartColumn)output.chartColumn=chartColumn;
  if(grouped){output.metricColumns=metricNames;await addComparison(database,ctx,actor,config,output,dateContext);}
  output.insights=require('./postgres-insights').observations(output);
  return output;
}
// Beside each group, the same number for the earlier period. A date group has no row to match, so its comparison is the totals above the chart.
async function addComparison(database,ctx,actor,config,output,dateContext){
  const window=compareWindow(config,dateContext),dataset=registry.get(config.dataset);
  if(!window)return;
  output.comparison={from:window.from,to:window.to,previousFrom:window.previousFrom,previousTo:window.previousTo};
  if(!config.groups.length||config.groups.some(field=>dataset.fields[field]==='date'))return;
  const primary=metricColumns(config)[0],earlier=await run(database,ctx,actor,{...config,compare:'',extras:[],chartMeasure:'',filters:window.filters,topN:null,sort:primary,chart:'table'},{limit:1001});
  const key=row=>JSON.stringify(config.groups.map(field=>row[field])),found=new Map(earlier.rows.map((row,index)=>[key(row),{row,index}]));
  output.columns.push('previous','change');
  const named=String(output.columnLabels[primary]).toLowerCase();output.columnLabels.previous='Previous '+named;output.columnLabels.change='Change in '+named;
  output.columnTypes.previous=output.columnTypes[primary];output.columnTypes.change='number';
  output.rows.forEach((row,index)=>{
    const match=found.get(key(row)),previous=match?match.row[primary]:null,change=match?changeBetween(row[primary],previous):null;
    row.previous=previous;row.change=change===null?null:Number(change.toFixed(1));
    output.displayRows[index].previous=match?earlier.displayRows[match.index][primary]:(earlier.hasMore?'—':'None');
    output.displayRows[index].change=changeText(change);
  });
}
// The totals across the whole report, each with its earlier period when one was asked for.
async function totals(database,ctx,actor,config){
  if(config.dataset==='composed'||(!config.groups.length&&!config.summary))return null;
  const dateContext=await require('../lib/business-time').forWorkspace(database,ctx.workspaceId),dataset=registry.get(config.dataset);
  const whole={...config,columns:[],groups:[],summary:true,dateGrain:'exact',sort:'',chart:'table',topN:null,compare:'',chartMeasure:''};
  let current,previous=null;const window=compareWindow(config,dateContext);
  try{
    current=await run(database,ctx,actor,whole,{limit:2});
    if(window)previous=await run(database,ctx,actor,{...whole,filters:window.filters},{limit:2});
  }catch(error){if(error instanceof ValidationError)return null;throw error;}
  const lowerIsBetter=measure=>/cogs|cost|expense|refund|return|discount/.test(String(measure||''));
  return {comparison:window?{from:window.from,to:window.to,previousFrom:window.previousFrom,previousTo:window.previousTo}:null,
    chartColumn:config.chartMeasure||metricColumns(config)[0],
    metrics:metricColumns(config).map(column=>{
      const metric=metricOf(config,column),value=current.rows[0]?.[column],before=previous?.rows[0]?.[column],change=previous&&before!=null?changeBetween(value,before):null;
      return {column,label:current.columnLabels[column]||metricLabel(dataset,metric.aggregate,metric.measure,column),display:String(current.displayRows[0]?.[column]??'—'),
        previousDisplay:before!=null?String(previous.displayRows[0][column]):null,change:change===null?null:Number(change.toFixed(1)),changeText:change===null?null:changeText(change),
        good:change===null||change===0?null:lowerIsBetter(metric.measure)?change<0:change>0};
    })};
}
async function countAtMost(database,ctx,actor,spec,maximum){
  if(spec?.dataset==='composed')return composed.countAtMost(database,ctx,actor,spec,maximum);
  const config=require('./relative-dates').resolve(normalize(spec,actor),await require('../lib/business-time').forWorkspace(database,ctx.workspaceId)),dataset=registry.get(config.dataset);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)
    invalid('That export size is unavailable.');
  if(dataset.commercialCapability){const entitlements=require('../commercial/entitlements');
    const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
    await entitlements.assertCapability(database,scope,dataset.commercialCapability,{allowReadOnly:true});}
  if(config.summary)return 1;
  const values=[ctx.workspaceId];
  const clauses=config.filters.map((filter)=>{if(!['is_null','is_empty','not_empty'].includes(filter.operator))values.push(filterParameter(filter));
    return dataset.filterAtSource?.(filter)?null:condition({...filter,type:dataset.fields[filter.field]},values.length);}).filter(Boolean);
  const where=clauses.length?`WHERE ${clauses.join(' AND ')}`:'';
  const groups=config.groups.map((field)=>config.dateGrain!=='exact'&&dataset.fields[field]==='date'
    ?`date_trunc('${config.dateGrain}',${quote(field)}::timestamp)::date`:quote(field));
  values.push(maximum+1);
  const limitIndex=values.length;
  const row=(await database.transaction(async client=>{
    const profitAccountIds=await require('./postgres-profit-scope').accountIds(client,ctx.workspaceId,config);
    const rawSource=dataset.sourceTransform?dataset.sourceTransform(dataset.source,config):dataset.source;
    const queryValues=values.slice(),boundedSource=require('./postgres-profit-scope').bind(rawSource,queryValues,profitAccountIds);
    const sql=`WITH source AS (${boundedSource}) SELECT COUNT(*)::bigint AS count FROM (
      SELECT 1 FROM source ${where} ${groups.length?`GROUP BY ${groups.join(',')}`:''}
      LIMIT $${limitIndex}) bounded`;
    return client.query(sql,queryValues);
  },{isolation:config.dataset==='profit_activity'?'REPEATABLE READ':'READ COMMITTED',readOnly:true,statementTimeoutMs:20000,lockTimeoutMs:2000,jit:false})).rows[0];
  return Math.min(Number(row.count),config.topN??Number.POSITIVE_INFINITY);
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
  const suffix=' - source records';
  const sourceTitle=config.title.slice(0,100-suffix.length).trimEnd()+suffix;
  return normalize({...config,extras:[],compare:'',chartMeasure:'',title:sourceTitle,groups:[],summary:false,
    aggregate:'count',measure:'',dateGrain:'exact',columns,topN:null,
    filters:[...config.filters,...groupFilters],sort:config.groups[0]||columns[0],chart:'table'},actor);
}
async function save(database,ctx,actor,spec,{id=null,schedule=null,expectedRevision=null}={}){
 const work=async client=>{const config=await assertWritableCapabilities(client,ctx,spec,actor),prior=id?(await client.query('SELECT * FROM stockchief_runtime.report_templates WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE',[ctx.workspaceId,ctx.actorId,id])).rows[0]:null;if(id&&!prior)invalid('That report template is not yours to edit.');if(prior&&expectedRevision!==null&&Number(prior.revision)!==Number(expectedRevision))invalid('This saved report changed. Review its current settings first.');
 const local=require('./local-schedule'),defaultZone=(await require('../lib/business-time').forWorkspace(client,ctx.workspaceId)).timeZone,delivery=schedule|| (prior?local.fromTemplate(prior):{}),normalized=local.normalize(delivery,defaultZone),recipient=safeText(delivery.recipient||prior?.delivery_email||actor.email,200);if(!recipient||!actor.email||recipient.toLowerCase()!==actor.email.toLowerCase())invalid('Reports can only be delivered to your account email.');
 const paused=delivery.paused??prior?.schedule_paused??false,next=paused?null:local.next(normalized),reportId=id||newId('report');
 if(!prior){const entitlements=require('../commercial/entitlements');await entitlements.assertMeterCapacity(client,await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),'saved_reports',1);}
 if(normalized.frequency!=='none'&&(!prior||prior.schedule_frequency==='none')){
  const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId);
  await entitlements.assertMeterCapacity(client,scope,'scheduled_reports',1);
 }
 const row=(await client.query(`INSERT INTO stockchief_runtime.report_templates(id,workspace_id,owner_user_id,title,definition,schedule_frequency,schedule_hour_utc,delivery_email,schedule_time_zone,schedule_hour_local,schedule_minute,schedule_weekday,schedule_paused,next_send_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,definition=EXCLUDED.definition,schedule_frequency=EXCLUDED.schedule_frequency,schedule_hour_utc=EXCLUDED.schedule_hour_utc,delivery_email=EXCLUDED.delivery_email,schedule_time_zone=EXCLUDED.schedule_time_zone,schedule_hour_local=EXCLUDED.schedule_hour_local,schedule_minute=EXCLUDED.schedule_minute,schedule_weekday=EXCLUDED.schedule_weekday,schedule_paused=EXCLUDED.schedule_paused,next_send_at=EXCLUDED.next_send_at,revision=stockchief_runtime.report_templates.revision+1,updated_at=now() WHERE stockchief_runtime.report_templates.workspace_id=EXCLUDED.workspace_id AND stockchief_runtime.report_templates.owner_user_id=EXCLUDED.owner_user_id AND stockchief_runtime.report_templates.deleted_at IS NULL RETURNING *`,[reportId,ctx.workspaceId,ctx.actorId,config.title,JSON.stringify(config),normalized.frequency,next?next.getUTCHours():normalized.hour,recipient,normalized.timeZone,normalized.hour,normalized.minute,normalized.weekday,paused,next?.toISOString()||null])).rows[0];if(!row)invalid('That saved report is unavailable.');return row;
 };return typeof database.transaction==='function'?database.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true}):work(database);
}
async function list(database,ctx,actor){
  const rows=(await database.query(`SELECT id,title,definition,schedule_frequency,schedule_hour_utc,schedule_hour_local,schedule_minute,schedule_weekday,schedule_time_zone,schedule_paused,next_send_at,revision,
      delivery_email,last_delivered_at,last_error,updated_at,(SELECT jsonb_build_object('id',d.id,'status',d.status,'requestedAt',d.created_at,'completedAt',d.completed_at) FROM stockchief_runtime.report_deliveries d WHERE d.workspace_id=report_templates.workspace_id AND d.template_id=report_templates.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) latest_delivery
      FROM stockchief_runtime.report_templates WHERE workspace_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 100`,[ctx.workspaceId,ctx.actorId])).rows;
  return rows.filter((row)=>{try{normalize(row.definition,actor);return true;}catch{return false;}});
}
async function load(database,ctx,actor,id){
  const row=(await database.query(`SELECT t.*,(SELECT jsonb_build_object('id',d.id,'status',d.status,'requestedAt',d.created_at,'completedAt',d.completed_at) FROM stockchief_runtime.report_deliveries d WHERE d.workspace_id=t.workspace_id AND d.template_id=t.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) latest_delivery FROM stockchief_runtime.report_templates t
    WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND deleted_at IS NULL`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  if(!row)invalid('That saved report is unavailable.');
  return {...row,definition:normalize(row.definition,actor)};
}

module.exports={normalize,assertWritableCapabilities,inspectionSpec,queryContract,querySyntax,queryFor,run,totals,countAtMost,save,list,load,drilldownSpec,comparableGroupAmounts,
  aggregateColumn:AGGREGATE_COLUMN};
