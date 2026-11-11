'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const {hash}=require('../pricing/postgres-promotions');
const storage=require('../commercial/storage-capacity');

const profileSql=`i.tracking_mode,i.unit_label,i.quantity_precision,i.quantity_increment,
  i.secondary_unit_label,i.secondary_precision,i.secondary_increment`;

const source=`SELECT l.workspace_id,l.campaign_id,l.location_id,l.sku_id,
  jsonb_build_object('mode',i.tracking_mode,'quantity',b.on_hand::text,'secondary',b.secondary_on_hand::text,
    'entries',coalesce(batch.entries,serial.entries,'[]'::jsonb)) AS evidence
  FROM warehouse_count_campaign_lines l
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN balances b ON b.workspace_id=l.workspace_id AND b.location_id=l.location_id AND b.sku_id=l.sku_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('code',lot.code,'quantity',lb.quantity::text,'secondary',lb.secondary_quantity::text)
      ORDER BY lot.code,lot.id) entries FROM lots lot
    JOIN lot_balances lb ON lb.workspace_id=lot.workspace_id AND lb.lot_id=lot.id AND lb.location_id=l.location_id
    WHERE i.tracking_mode='lot' AND lot.workspace_id=l.workspace_id AND lot.sku_id=l.sku_id
      AND (lb.quantity<>0 OR coalesce(lb.secondary_quantity,0)<>0)
  ) batch ON i.tracking_mode='lot'
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('code',u.serial,'quantity','1','secondary',u.secondary_quantity::text)
      ORDER BY u.serial,u.id) entries FROM serial_units u
    WHERE i.tracking_mode='serial' AND u.workspace_id=l.workspace_id AND u.sku_id=l.sku_id
      AND u.location_id=l.location_id AND u.status='in_stock'
  ) serial ON i.tracking_mode='serial'
  WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND (i.tracking_mode<>'quantity' OR i.secondary_unit_label IS NOT NULL)`;

async function capture(c,workspaceId,id){
  const {rows:[{bytes}]}=await c.query(`WITH recorded AS (
    INSERT INTO stockchief_runtime.agent_count_position_evidence(workspace_id,campaign_id,location_id,sku_id,before_count)
    ${source} RETURNING *
  ) SELECT coalesce(sum(octet_length(convert_to(to_jsonb(recorded)::text,'UTF8'))),0) AS bytes FROM recorded`,[workspaceId,id]);
  return Number(bytes);
}

function amount(item,value,{secondary=false,positive=false}={}){
  const label=secondary?'Physical weight':'Physical quantity';
  if(value==null||String(value).trim()==='')throw new ValidationError('Enter the '+label.toLowerCase()+'.');
  return exact.canonical(stock.validate(item,value,{secondary,positive,label,total:true}));
}

function compareCode(a,b){return a.code<b.code?-1:a.code>b.code?1:0;}

function readEntries(item,input){
  const entries=input.entries??[];
  if(typeof entries!=='object'||entries===null)throw new ValidationError('Use the current count form to enter each identifier.');
  const rows=Object.values(entries).filter(entry=>entry&&[entry.code,entry.quantity,entry.secondary].some(value=>String(value??'').trim()!==''));
  const parsed=rows.map(entry=>{
    if(typeof entry.code!=='string'||!entry.code.trim())
      throw new ValidationError(item.tracking_mode==='lot'?'Enter the physical lot code.':'Enter the physical serial number.');
    return {code:entry.code,quantity:item.tracking_mode==='serial'?'1':amount(item,entry.quantity,{positive:true}),
      secondary:item.secondary_unit_label?amount(item,entry.secondary,{secondary:true,positive:true}):null};
  }).sort(compareCode);
  if(new Set(parsed.map(r=>r.code)).size!==parsed.length)throw new ValidationError('Enter each physical identifier once at this stock position.');
  return parsed;
}

function sameValue(left,right){
  if(left==null||right==null)return left==null&&right==null;
  return exact.canonical(left,{signed:true})===exact.canonical(right,{signed:true});
}

function sameEntry(a,b){return a.code===b.code&&sameValue(a.quantity,b.quantity)&&sameValue(a.secondary,b.secondary);}

function matches(saved,actual){
  if(!saved||!actual||saved.mode!==actual.mode||!sameValue(saved.quantity,actual.quantity)||!sameValue(saved.secondary,actual.secondary))return false;
  if(saved.entries.length!==actual.entries.length)return false;
  const current=new Map(actual.entries.map(entry=>[entry.code,entry]));
  return saved.entries.every(entry=>current.has(entry.code)&&sameEntry(entry,current.get(entry.code)));
}

async function collect(c,ctx,id,row,input){
  const args=[ctx.workspaceId,id,row.location_id,row.sku_id];
  const prior=row.observation;
  const tracked=row.tracking_mode!=='quantity',weighed=Boolean(row.secondary_unit_label);
  if(input.entryAction!=null&&!['add','finish','reset'].includes(input.entryAction))throw new ValidationError('Choose how to save the count entries.');
  if(input.entryAction==='reset'){
    if(row.counter_quantity!=null)throw new ValidationError('This position already has a count. Ask the owner to review the difference.');
    await c.query(`UPDATE stockchief_runtime.agent_count_position_evidence SET observation=NULL
      WHERE workspace_id=$1 AND campaign_id=$2 AND location_id=$3 AND sku_id=$4`,args);
    return {done:false};
  }
  const finish=input.entryAction!=='add';
  let next;
  if(tracked){
    const incoming=readEntries(row,input),none=input.noStock==='yes';
    if(none&&(incoming.length||prior?.entries.length))throw new ValidationError('Remove saved identifiers before confirming that this position is empty.');
    const byCode=new Map((prior?.entries||[]).map(entry=>[entry.code,entry]));
    for(const entry of incoming){
      const saved=byCode.get(entry.code);
      if(saved&&!sameEntry(saved,entry))throw new ValidationError('A saved identifier has different measurements. Clear the unfinished entries to recount it.');
      byCode.set(entry.code,entry);
    }
    const entries=[...byCode.values()].sort(compareCode);
    if(!entries.length&&!none)throw new ValidationError('Enter the physical identifiers or confirm that this stock position is empty.');
    if(row.tracking_mode==='serial'&&incoming.length){
      const duplicate=await c.query(`SELECT 1 FROM stockchief_runtime.agent_count_position_evidence e
        CROSS JOIN LATERAL jsonb_array_elements(e.observation->'entries') other
        WHERE e.workspace_id=$1 AND e.campaign_id=$2 AND e.location_id<>$3 AND e.sku_id=$4
        AND e.observation IS NOT NULL AND other->>'code'=ANY($5::text[]) LIMIT 1`,[...args,incoming.map(e=>e.code)]);
      if(duplicate.rowCount)throw new ValidationError('A serial was already recorded at another position in this count.');
    }
    const quantity=amount(row,entries.reduce((total,entry)=>exact.add(total,entry.quantity),'0'));
    const secondary=weighed?amount(row,entries.reduce((total,entry)=>exact.add(total,entry.secondary),'0'),{secondary:true}):null;
    next={mode:row.tracking_mode,quantity,secondary,entries};
  }else{
    const quantity=amount(row,input.quantity),secondary=amount(row,input.secondaryQuantity,{secondary:true});
    if((quantity==='0')!==(secondary==='0'))throw new ValidationError('Enter the physical pieces and independent weight you observed. Both are zero for an empty position.');
    next={mode:row.tracking_mode,quantity,secondary,entries:[]};
  }
  if(row.counter_quantity!=null){
    if(matches(prior,next))return {done:true,quantity:next.quantity,replayed:true};
    throw new ValidationError('This position already has a count. Ask the owner to review the difference.');
  }
  if(!matches(prior,next)){
    const bytes=Buffer.byteLength(JSON.stringify(next))-Buffer.byteLength(JSON.stringify(prior??null));
    if(bytes>0)await storage.reserve(c,ctx.workspaceId,'phone-count:'+hash([id,row.location_id,row.sku_id,next]),bytes+512,{finished:true});
    await c.query(`UPDATE stockchief_runtime.agent_count_position_evidence SET observation=$5
      WHERE workspace_id=$1 AND campaign_id=$2 AND location_id=$3 AND sku_id=$4`,[...args,next]);
  }
  return {done:finish,quantity:next.quantity};
}

async function current(c,workspaceId,id,pairs=null){
  const {rows}=await c.query(source+` AND ($3::jsonb IS NULL OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset($3::jsonb) p(location_id text,sku_id text)
    WHERE p.location_id=l.location_id AND p.sku_id=l.sku_id
  ))`,[workspaceId,id,pairs]);
  return rows;
}

async function checkReviewed(c,workspaceId,id,pairs=null){
  const {rows}=await c.query(`WITH current_positions AS (${source})
    SELECT e.location_id,e.sku_id,e.observation,e.reviewed_at,cp.evidence,s.code,l.name location
    FROM stockchief_runtime.agent_count_position_evidence e
    JOIN skus s ON s.workspace_id=e.workspace_id AND s.id=e.sku_id
    JOIN locations l ON l.workspace_id=e.workspace_id AND l.id=e.location_id
    LEFT JOIN current_positions cp ON cp.location_id=e.location_id AND cp.sku_id=e.sku_id
    WHERE e.workspace_id=$1 AND e.campaign_id=$2
    AND ($3::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) p(location_id text,sku_id text)
      WHERE p.location_id=e.location_id AND p.sku_id=e.sku_id))
    ORDER BY e.location_id,e.sku_id`,[workspaceId,id,pairs]);
  const unresolved=rows.find(row=>!row.reviewed_at||!matches(row.observation,row.evidence));
  if(unresolved)throw new ValidationError('Review the physical identifiers and measures for '+unresolved.code+' at '+unresolved.location+
    '. Resolve any stock discrepancy separately before closing this worksheet.');
}

module.exports={capture,collect,current,matches,checkReviewed,profileSql};
