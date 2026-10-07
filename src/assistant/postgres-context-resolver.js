'use strict';

const {FIELDS}=require('./postgres-capability-registry');

// These are entity types, not language patterns. Every query is workspace
// scoped; the model never receives database access or gets to choose SQL.
const ENTITIES={
  sku:{query:`SELECT s.code AS value,CONCAT_WS(' ',i.name,s.variant_label,s.code) AS label
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1`,order:'label'},
  location:{query:`SELECT name AS value,name AS label FROM locations
    WHERE workspace_id=$1 AND is_active=1`,order:'label'},
  supplier:{query:`SELECT name AS value,name AS label FROM suppliers
    WHERE workspace_id=$1 AND status='active'`,order:'label'},
  customer:{query:`SELECT name AS value,name AS label FROM customers
    WHERE workspace_id=$1 AND record_state='ACTIVE'`,order:'label'},
  purchase_order:{query:`SELECT po_number AS value,po_number AS label FROM purchase_orders
    WHERE workspace_id=$1`,order:'label'},
  supplier_bill:{query:`SELECT bill_number AS value,bill_number AS label FROM accounting_supplier_bills
    WHERE workspace_id=$1`,order:'label'},
  mailbox:{query:`SELECT display_name AS value,display_name AS label FROM workspace_connectors
    WHERE workspace_id=$1 AND provider_type IN ('gmail','microsoft365')
      AND status='connected' AND paused_at IS NULL`,order:'label'},
};

function nonempty(value){return typeof value==='string'&&value.trim()?value.trim():null;}
function normalize(value){return String(value||'').toLocaleLowerCase().trim();}
function tokens(value){return normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((part)=>{
  if(part.length>4&&part.endsWith('ies'))return `${part.slice(0,-3)}y`;
  if(part.length>3&&part.endsWith('s')&&!part.endsWith('ss'))return part.slice(0,-1);
  return part;
});}
function convert(field,value){
  if(value===null||value===undefined||value==='')return null;
  const spec=FIELDS[field];if(!spec)throw new TypeError(`Unknown field ${field}`);
  if(spec.type==='string')return nonempty(String(value));
  const number=Number(value);
  if(!Number.isFinite(number)||number<0||spec.type==='integer'&&!Number.isSafeInteger(number))return null;
  return number;
}

async function choices(database,workspaceId,entity,{scope=null,wanted=null}={}){
  const def=ENTITIES[entity];if(!def)return [];
  let statement=def.query;
  if(entity==='sku'&&scope==='currently_stocked')statement+=` AND EXISTS (
    SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.on_hand>0)`;
  const source=`(${statement}) AS candidate`;
  if(wanted){
    const exact=(await database.query(`SELECT * FROM ${source}
      WHERE lower(value)=lower($2) OR lower(label)=lower($2) ORDER BY label LIMIT 9`,
    [workspaceId,wanted])).rows;
    if(exact.length)return exact;
    const partial=(await database.query(`SELECT * FROM ${source}
      WHERE strpos(lower(label),lower($2))>0 ORDER BY label LIMIT 9`,
    [workspaceId,wanted])).rows;
    if(partial.length)return partial;
    const terms=tokens(wanted).slice(0,8);
    if(terms.length)return (await database.query(`SELECT * FROM ${source}
      WHERE ${terms.map((_,index)=>`strpos(lower(label),$${index+2})>0`).join(' AND ')}
      ORDER BY label LIMIT 9`,[workspaceId,...terms])).rows;
    return [];
  }
  return (await database.query(`SELECT * FROM ${source} ORDER BY label LIMIT 9`,[workspaceId])).rows;
}

function choose(rows,wanted){
  if(!wanted)return rows.length===1?{value:rows[0].value,source:'single_valid_candidate'}:
    rows.length?{ambiguous:rows.slice(0,8)}:{missing:true};
  const exact=rows.filter((row)=>normalize(row.value)===normalize(wanted)||normalize(row.label)===normalize(wanted));
  if(exact.length===1)return {value:exact[0].value,source:'exact_record'};
  if(exact.length>1)return {ambiguous:exact.slice(0,8)};
  const partial=rows.filter((row)=>normalize(row.label).includes(normalize(wanted)));
  const semantic=partial.length?partial:rows.filter((row)=>{
    const available=new Set(tokens(`${row.label} ${row.value}`));
    return tokens(wanted).every((token)=>available.has(token));
  });
  return semantic.length===1?{value:semantic[0].value,source:'unique_record_match'}:
    semantic.length?{ambiguous:semantic.slice(0,8)}:{notFound:true};
}

/** Resolve the same field type the same way, regardless of which capability asks. */
async function resolveArguments(database,ctx,contract,provided={},context={}){
  const args={};const provenance={};const unresolved=[];
  for(const field of contract.fields){
    const spec=FIELDS[field];
    let raw=convert(field,provided[field]);let source=raw!==null?'owner_message':null;
    if(raw===null&&context.continuesPending){
      raw=convert(field,context.previousArgs?.[field]);if(raw!==null)source='previous_turn';
    }
    if(raw===null&&context.dependencyArgs){
      raw=convert(field,context.dependencyArgs[field]);if(raw!==null)source='prior_step';
    }
    if(raw===null&&context.page?.[field]){
      raw=convert(field,context.page[field]);if(raw!==null)source='current_record';
    }
    if(spec.entity&&ENTITIES[spec.entity]&&!(contract.name==='location.create'&&field==='location')){
      const list=await choices(database,ctx.workspaceId,spec.entity,
        {scope:provided.skuScope||context.previousArgs?.skuScope||null,wanted:raw});
      // Never resolve both legs of a transfer to the same unique location.
      const eligible=field==='toLocation'&&args.fromLocation
        ?list.filter((row)=>row.value!==args.fromLocation):list;
      const matched=choose(eligible,raw);
      if(matched.value){args[field]=matched.value;provenance[field]={source:raw?source:matched.source,
        value:matched.value};continue;}
      if(raw&&matched.notFound&&contract.allowUnknownEntities?.includes(field)){
        args[field]=raw;provenance[field]={source:'unverified_reference',value:raw};continue;
      }
      if(raw||matched.ambiguous)unresolved.push({field,reason:matched.notFound?'not_found':
        matched.ambiguous?'ambiguous':'missing',supplied:raw,choices:matched.ambiguous||[],
        scope:field==='sku'?provided.skuScope||context.previousArgs?.skuScope||null:null});
      args[field]=null;continue;
    }
    args[field]=raw;
    if(raw!==null)provenance[field]={source,value:raw};
  }
  if(args.fromLocation&&args.toLocation&&args.fromLocation===args.toLocation)
    unresolved.push({field:'toLocation',reason:'same_as_source',supplied:args.toLocation,choices:[]});
  for(const field of contract.required||[]){
    if(args[field]===null&&!unresolved.some((entry)=>entry.field===field))
      unresolved.push({field,reason:'missing',supplied:null,choices:[]});
  }
  return {args,provenance,unresolved};
}

module.exports={ENTITIES,choices,choose,convert,resolveArguments,tokens};
