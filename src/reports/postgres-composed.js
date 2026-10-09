'use strict';

const registry=require('./postgres-registry');
const permissions=require('../actions/permissions');
const {ValidationError}=require('../domain/errors');

// These are workspace-unique business identifiers in the canonical schema.
// Never compose on display names: two customers can have the same name.
const DIMENSIONS=Object.freeze({
  sku:'SKU',order_number:'Sales order number',po_number:'Purchase order number',
  shipment_number:'Shipment number',
});
const AGGREGATES=new Set(['count','sum','average','minimum','maximum','ratio']);
const OPERATORS=new Set(['equals','contains','at_least','at_most','after','before','is_null']);
const IDENTIFIER=/^[a-z][a-z0-9_]{0,23}$/u;
const FORMULA_LIMIT=160;
function invalid(message){throw new ValidationError(message);}
function text(value,length=120){const result=String(value??'').trim();
  if(result.length>length)invalid('A report value is too long.');return result;}
function quote(name){return `"${name}"`;}
function allowedSources(actor,dimension){return Object.entries(registry.datasets)
  .filter(([,dataset])=>dataset.fields[dimension]&&permissions.can(actor,dataset.permission))
  .map(([key,dataset])=>({key,label:dataset.label,fields:dataset.fields,
    metrics:dataset.metrics||{},moneyCompleteness:dataset.moneyCompleteness||{},
    commercialCapability:dataset.commercialCapability||null}));}
function dimensions(actor){return Object.entries(DIMENSIONS).map(([key,label])=>({key,label,
  sources:allowedSources(actor,key)})).filter((entry)=>entry.sources.length>=2);}

// A small expression grammar. Identifiers are selected metric aliases only;
// numbers are literals. No functions, property access, SQL, or JavaScript.
function formulaTokens(input){
  const tokens=String(input).match(/\s*(?:[a-z][a-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-])/giu)||[];
  if(tokens.join('').replaceAll(/\s/gu,'')!==input.replaceAll(/\s/gu,'')||tokens.length>40)
    invalid('Use metric names, numbers, +, -, ×, ÷ and parentheses only.');
  return tokens.map((token)=>token.trim());
}
function parseFormula(input,metricTypes){
  const tokens=formulaTokens(input);let at=0;
  const primary=()=>{
    const token=tokens[at++];
    if(token==='('){const node=expression();if(tokens[at++]!==')')invalid('Close the calculation parentheses.');return node;}
    if(token==='-'){const node=primary();return {sql:`(-${node.sql})`,type:node.type,aliases:node.aliases};}
    if(token&&/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(token)){
      if(!Number.isFinite(Number(token)))invalid('Use a finite calculation number.');
      return {sql:Number(token).toString(),type:'number',aliases:new Set()};
    }
    if(token&&Object.hasOwn(metricTypes,token))return {sql:quote(token),type:metricTypes[token],
      aliases:new Set([token])};
    invalid('Use only the selected metric names in a calculation.');
  };
  const combine=(left,operator,right)=>{
    let type;
    if(operator==='+'||operator==='-'){
      if(left.type!==right.type)invalid('Add or subtract only values with matching units.');
      type=left.type;
    }else if(operator==='*'){
      if(left.type==='money'&&right.type==='money')invalid('Money cannot be multiplied by money.');
      type=left.type==='money'||right.type==='money'?'money':'number';
    }else{
      if(right.type==='money'&&left.type!=='money')invalid('A count cannot be divided by money.');
      type=left.type==='money'&&right.type==='number'?'money':'number';
    }
    return {sql:`(${left.sql} ${operator} ${operator==='/'?`NULLIF(${right.sql},0)`:right.sql})`,
      type,aliases:new Set([...left.aliases,...right.aliases])};
  };
  const term=()=>{let node=primary();while(tokens[at]==='*'||tokens[at]==='/'){
    const operator=tokens[at++];node=combine(node,operator,primary());}return node;};
  const expression=()=>{let node=term();while(tokens[at]==='+'||tokens[at]==='-'){
    const operator=tokens[at++];node=combine(node,operator,term());}return node;};
  const result=expression();if(at!==tokens.length)invalid('That calculation is incomplete.');
  if(result.aliases.size===0)invalid('A calculation must use at least one selected metric.');
  return result;
}
function normalize(spec,actor){
  const dimension=text(spec.dimension,30);
  if(!Object.hasOwn(DIMENSIONS,dimension))invalid('Choose a governed shared identifier.');
  const available=new Map(allowedSources(actor,dimension).map((entry)=>[entry.key,entry]));
  const raw=Array.isArray(spec.metrics)?spec.metrics:[];
  if(raw.length<2||raw.length>4)invalid('Combine two to four recorded measures.');
  const aliases=new Set(),datasets=new Set(),metricTypes={};let moneyCurrency=null;
  const metrics=raw.map((entry)=>{
    const datasetKey=text(entry.dataset,60),source=available.get(datasetKey);
    if(!source)invalid('That dataset cannot be joined on this identifier or is unavailable to you.');
    const alias=text(entry.alias,24);
    if(!IDENTIFIER.test(alias)||alias==='calculated'||alias===dimension||aliases.has(alias))
      invalid('Give each measure a distinct simple name.');
    aliases.add(alias);datasets.add(datasetKey);
    const aggregate=text(entry.aggregate,20)||'sum';
    if(!AGGREGATES.has(aggregate))invalid('Choose a supported calculation for each measure.');
    const measure=aggregate==='count'?'':text(entry.measure,60),metric=source.metrics[measure];
    if(aggregate==='ratio'&&(!metric||metric.kind!=='ratio'))invalid('Choose a registered weighted ratio.');
    if(!['count','ratio'].includes(aggregate)&&!['number','money_minor'].includes(source.fields[measure]))
      invalid('Choose a recorded numeric measure.');
    const filters=Array.isArray(entry.filters)?entry.filters:[];
    if(filters.length>6)invalid('Use at most six filters per source.');
    const cleanFilters=filters.map((filter)=>{
      const field=text(filter.field,60),operator=text(filter.operator,20),value=text(filter.value);
      const type=source.fields[field];if(!type||!OPERATORS.has(operator)||(!value&&operator!=='is_null'))
        invalid('Choose registered source filters only.');
      if(['after','before'].includes(operator)&&type!=='date')invalid('Only dates use before or after.');
      if(operator==='contains'&&type!=='text')invalid('Contains requires a text field.');
      if(['at_least','at_most'].includes(operator)&&!['number','money_minor','date'].includes(type))
        invalid('This field cannot be compared numerically.');
      if(type==='date'&&operator!=='is_null'&&!/^\d{4}-\d{2}-\d{2}$/u.test(value))
        invalid('Use dates in YYYY-MM-DD format.');
      if(['number','money_minor'].includes(type)&&operator!=='is_null'&&!Number.isFinite(Number(value)))
        invalid('Use a valid numeric filter.');
      return {field,operator,value};
    });
    const type=aggregate==='ratio'?'number':aggregate==='count'?'number':
      source.fields[measure]==='money_minor'?'money':'number';
    metricTypes[alias]=type;
    const completeness=source.moneyCompleteness?.[measure];
    if(completeness&&!cleanFilters.some((filter)=>filter.field===completeness.field
      &&filter.operator==='equals'&&filter.value===completeness.value))
      invalid(`Filter ${completeness.field.replaceAll('_',' ')} to ${completeness.value} before combining that amount.`);
    if(type==='money'||metric?.currencySensitive){
      const currency=cleanFilters.find((filter)=>filter.field==='currency'&&filter.operator==='equals'
        &&/^[A-Z]{3}$/u.test(filter.value))?.value;
      if(!currency)invalid('Filter monetary measures to one exact currency before combining them.');
      if(moneyCurrency&&moneyCurrency!==currency)invalid('Combined money must use the same currency.');
      moneyCurrency=currency;
    }
    return {alias,dataset:datasetKey,aggregate,measure:aggregate==='count'?'':measure,filters:cleanFilters};
  });
  if(datasets.size<2)invalid('Choose measures from at least two different datasets.');
  const formula=text(spec.formula,FORMULA_LIMIT);
  const parsed=formula?parseFormula(formula,metricTypes):null;
  const formulaLabel=text(spec.formulaLabel,60)||'Calculated';
  const formulaUnit=parsed?.type==='money'?'money':spec.formulaUnit==='percent'?'percent':'number';
  if(spec.formulaUnit==='money'&&parsed?.type!=='money')invalid('This calculation does not produce money.');
  const chart=['table','bar'].includes(spec.chart)?spec.chart:'table';
  const chartMeasure=text(spec.chartMeasure,24)|| (formula?'calculated':metrics[0].alias);
  if(chartMeasure!=='calculated'&&!aliases.has(chartMeasure)||chartMeasure==='calculated'&&!formula)
    invalid('Choose a selected measure for the chart.');
  const sort=text(spec.sort,24)||dimension;
  if(sort!==dimension&&sort!=='calculated'&&!aliases.has(sort)||sort==='calculated'&&!formula)
    invalid('Sort by the identifier or a selected measure.');
  const layout=['chart_first','table_first','dashboard'].includes(spec.layout)?spec.layout:'chart_first';
  const title=text(spec.title,100)||`Combined ${DIMENSIONS[dimension]} report`;
  return {dataset:'composed',dimension,metrics,formula,formulaLabel,formulaUnit,chart,chartMeasure,sort,
    direction:spec.direction==='asc'?'asc':'desc',layout,title,groups:[dimension],summary:false};
}
function filterSql(filter,index){const field=quote(filter.field),param=`$${index}`;
  if(filter.operator==='is_null')return `${field} IS NULL`;
  if(filter.operator==='equals')return `${field}=${param}`;
  if(filter.operator==='contains')return `${field} ILIKE ${param} ESCAPE '!'`;
  if(['at_least','after'].includes(filter.operator))return `${field}>=${param}`;
  return `${field}<=${param}`;
}
function filterValue(filter){return filter.operator==='contains'
  ?`%${filter.value.replaceAll('!','!!').replaceAll('%','!%').replaceAll('_','!_')}%`:filter.value;}
function queryFor(config,workspaceId,{limit=201,offset=0,count=false}={}){
  const values=[workspaceId],ctes=[],joins=[],keySources=[];
  config.metrics.forEach((metric,index)=>{
    const dataset=registry.get(metric.dataset),source=`source_${index}`,name=`measure_${index}`;
    ctes.push(`${source} AS (${dataset.source})`);
    const conditions=metric.filters.map((filter)=>{
      if(filter.operator!=='is_null')values.push(filterValue(filter));
      return filterSql(filter,values.length);
    });
    // A NULL business identifier cannot match across sources. Exclude it
    // instead of showing a synthetic row whose measures all appear missing.
    const where=`WHERE ${quote(config.dimension)} IS NOT NULL${conditions.length
      ?` AND ${conditions.join(' AND ')}`:''}`;
    const measure=quote(metric.measure),registered=dataset.metrics?.[metric.measure];
    const calculation=metric.aggregate==='count'?'COUNT(*)::numeric':
      metric.aggregate==='ratio'
        ?`ROUND(100.0*SUM(${quote(registered.numerator)})::numeric/NULLIF(SUM(${quote(registered.denominator)}),0),2)`:
        metric.aggregate==='sum'?`SUM(${measure})::numeric`:
          metric.aggregate==='average'?`AVG(${measure})::numeric`:
            metric.aggregate==='minimum'?`MIN(${measure})::numeric`:`MAX(${measure})::numeric`;
    ctes.push(`${name} AS (SELECT ${quote(config.dimension)} AS join_key,${calculation} AS ${quote(metric.alias)}
      FROM ${source} ${where} GROUP BY ${quote(config.dimension)})`);
    keySources.push(`SELECT join_key FROM ${name}`);
    joins.push(`LEFT JOIN ${name} ON ${name}.join_key=keys.join_key`);
  });
  ctes.push(`keys AS (${keySources.join(' UNION ')})`);
  const baseColumns=config.metrics.map((metric,index)=>`${quote(`measure_${index}`)}.${quote(metric.alias)} AS ${quote(metric.alias)}`);
  const base=`SELECT keys.join_key AS ${quote(config.dimension)},${baseColumns.join(',')}
    FROM keys ${joins.join(' ')}`;
  ctes.push(`combined AS (${base})`);
  const parsed=config.formula?parseFormula(config.formula,Object.fromEntries(config.metrics.map((metric)=>{
    const dataset=registry.get(metric.dataset),type=metric.aggregate==='ratio'||metric.aggregate==='count'
      ?'number':dataset.fields[metric.measure]==='money_minor'?'money':'number';
    return [metric.alias,type];}))):null;
  ctes.push(`computed AS (SELECT *,${parsed?`ROUND((${parsed.sql})::numeric,2)`:'NULL::numeric'}
    AS calculated FROM combined)`);
  const prefix=`WITH ${ctes.join(',')}`;
  if(count){values.push(limit);return {sql:`${prefix} SELECT COUNT(*)::bigint AS count FROM
    (SELECT 1 FROM computed LIMIT $${values.length}) bounded`,values};}
  values.push(limit,offset);
  return {sql:`${prefix} SELECT ${quote(config.dimension)},${config.metrics.map((metric)=>quote(metric.alias)).join(',')}
    ${config.formula?',calculated':''} FROM computed
    ORDER BY ${quote(config.sort)} ${config.direction==='asc'?'ASC':'DESC'} NULLS LAST,
      ${quote(config.dimension)} ASC NULLS LAST LIMIT $${values.length-1} OFFSET $${values.length}`,values};
}
async function checkEntitlements(database,ctx,config){
  const required=[...new Set(config.metrics.map((metric)=>registry.get(metric.dataset).commercialCapability).filter(Boolean))];
  if(!required.length)return;
  const entitlements=require('../commercial/entitlements');
  const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  for(const capability of required)await entitlements.assertCapability(database,scope,capability,{allowReadOnly:true});
}
async function run(database,ctx,actor,spec,{limit=201,offset=0}={}){
  const config=normalize(spec,actor);
  if(!Number.isSafeInteger(Number(offset))||Number(offset)<0||Number(offset)>1000000)
    invalid('That report page is unavailable. Narrow the filters.');
  await checkEntitlements(database,ctx,config);
  const pageLimit=Math.min(20001,Math.max(2,Number(limit)||201));
  const {sql,values}=queryFor(config,ctx.workspaceId,{limit:pageLimit,offset:Number(offset)});
  const fetched=(await database.transaction((client)=>client.query(sql,values),
    {isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:10000,lockTimeoutMs:2000})).rows;
  const hasMore=fetched.length===pageLimit,rows=hasMore?fetched.slice(0,-1):fetched;
  const columns=[config.dimension,...config.metrics.map((metric)=>metric.alias),...(config.formula?['calculated']:[])];
  const columnLabels={calculated:config.formulaLabel||'Calculated'};
  const currency=config.metrics.flatMap((metric)=>metric.filters.filter((filter)=>filter.field==='currency'
    &&filter.operator==='equals').map((filter)=>filter.value))[0]||null;
  const format=(value,type)=>{
    if(value==null)return 'Not recorded';
    if(type==='money')return require('../pricing/postgres-service').formatMinor(value,currency);
    if(type==='percent')return `${Number(value).toFixed(2)}%`;
    return Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
  };
  const metricTypes=Object.fromEntries(config.metrics.map((metric)=>{
    const dataset=registry.get(metric.dataset);
    const type=metric.aggregate==='ratio'?'percent':metric.aggregate==='count'?'number':
      dataset.fields[metric.measure]==='money_minor'?'money':'number';
    columnLabels[metric.alias]=`${dataset.label} · ${metric.aggregate==='ratio'
      ?dataset.metrics[metric.measure].label:metric.aggregate==='count'?'Count':
        `${metric.aggregate} ${metric.measure.replaceAll('_',' ')}`}`;
    return [metric.alias,type];
  }));
  const displayRows=rows.map((row)=>Object.fromEntries(columns.map((column)=>[
    column,column===config.dimension?row[column]:format(row[column],column==='calculated'
      ?config.formulaUnit:metricTypes[column])])));
  const result={config,columns,columnLabels,rows:rows.map((row)=>({...row,href:null})),displayRows,
    hasMore,offset:Number(offset),pageSize:pageLimit-1,asOf:new Date().toISOString(),
    provenance:{dataset:'composed',datasets:config.metrics.map((metric)=>metric.dataset),
      workspaceId:ctx.workspaceId,source:'PostgreSQL',grouped:true,currency},
    comparisonSafe:true,chartColumn:config.chartMeasure,
    sources:config.metrics.map((metric)=>({alias:metric.alias,dataset:metric.dataset,
      label:registry.get(metric.dataset).label}))};
  result.insights=require('./postgres-insights').observations(result);
  return result;
}
async function countAtMost(database,ctx,actor,spec,maximum){
  const config=normalize(spec,actor);
  if(!Number.isSafeInteger(maximum)||maximum<1||maximum>100000)
    invalid('That export size is unavailable.');
  await checkEntitlements(database,ctx,config);
  const {sql,values}=queryFor(config,ctx.workspaceId,{limit:maximum+1,count:true});
  const row=(await database.transaction((client)=>client.query(sql,values),
    {isolation:'READ COMMITTED',readOnly:true,statementTimeoutMs:20000,lockTimeoutMs:2000})).rows[0];
  return Number(row.count);
}
function drilldownSpec(spec,values,actor,alias){
  const config=normalize(spec,actor),metric=config.metrics.find((entry)=>entry.alias===alias);
  if(!metric||!Array.isArray(values)||values.length!==1)invalid('Choose one source measure and report row.');
  const dataset=registry.get(metric.dataset),value=values[0];
  const fields=Object.keys(dataset.fields),columns=[config.dimension,...fields.filter((field)=>field!==config.dimension)].slice(0,12);
  return {dataset:metric.dataset,title:`${config.title} · ${dataset.label} source records`,
    columns,groups:[],summary:false,dateGrain:'exact',aggregate:'count',measure:'',
    filters:[...metric.filters,{field:config.dimension,operator:value==null?'is_null':'equals',
      value:value==null?'':text(value,120)}],sort:config.dimension,direction:'asc',chart:'table'};
}
module.exports={DIMENSIONS,dimensions,normalize,queryFor,run,countAtMost,drilldownSpec,parseFormula};
