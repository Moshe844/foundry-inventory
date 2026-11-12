'use strict';

// Job 167: watch rules in plain words, alone on every plan.
//
// The owner writes a rule ("tell me if any Nike item drops under 20"). It is
// read without AI (watch-rule-parser.js) and the name in it is looked up in the
// records: a brand, category or tag on an active product, an active supplier or
// an active location. Anything unclear is asked back and nothing is saved.
// Saved rules count against the plan's shared rule allowance (Starter 5,
// Growth 50, Pro 500, Custom unlimited), and only the owner can change them.
//
// The routine check (operational-notices.refresh, run by the worker) checks
// every rule against current stock, sales, selling prices and batch expiry
// dates, raises one alert per matching product (or batch) and clears it when
// the condition no longer holds. Alerts reach the app, Needs you and, when the
// owner chose a mailbox, email (agent-alerts.js), exactly like job 166.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const exact=require('../domain/exact-quantity');
const parser=require('./watch-rule-parser');
const {unitCount}=require('../lib/units');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=167,key='watch-rules',path='/autopilot/reviews/'+key,rules='stockchief_runtime.agent_watch_rules';
const brandFact="lower(trim(coalesce(f.facts::jsonb->>'brand',f.facts::jsonb->>'Brand')))";
// Tags are recorded on the product as a list or a comma-separated text.
const tagsOf=facts=>`ARRAY(SELECT lower(trim(t)) FROM jsonb_each(CASE WHEN jsonb_typeof(${facts})='object' THEN ${facts} ELSE '{}'::jsonb END) e
  CROSS JOIN LATERAL regexp_split_to_table(CASE WHEN jsonb_typeof(e.value)='array' THEN (SELECT string_agg(v,',') FROM jsonb_array_elements_text(e.value) v)
    ELSE e.value#>>'{}' END,',') t WHERE lower(trim(e.key)) IN ('tag','tags','product tags') AND trim(t)<>'')`;

// Every product (or batch) a rule currently matches.
// $1 workspace, $2 a rule id or exact SKU ('' for all), $3 the business date.
const sql=`WITH r AS MATERIALIZED (SELECT * FROM ${rules} WHERE workspace_id=$1 AND enabled),
 active AS MATERIALIZED (SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1),
 products AS MATERIALIZED (SELECT s.id AS sku_id,s.code,s.item_id,concat_ws(' — ',i.name,nullif(s.variant_label,'')) AS product,i.unit_label,
     lower(trim(f.category)) AS category,${brandFact} AS brand,
     CASE WHEN EXISTS(SELECT 1 FROM r WHERE r.subject_kind='TAG') THEN ${tagsOf('f.facts::jsonb')} END AS tags
   FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
   LEFT JOIN catalogue_item_facts f ON f.workspace_id=s.workspace_id AND f.item_id=s.item_id
   WHERE s.workspace_id=$1 AND s.is_active=1 AND EXISTS(SELECT 1 FROM r)),
 scoped AS MATERIALIZED (SELECT r.id AS rule_id,r.instruction,r.condition,r.amount,r.inclusive,r.days,r.location_id,l.name AS location,p.*
   FROM r JOIN products p ON CASE r.subject_kind
     WHEN 'ALL' THEN true
     WHEN 'BRAND' THEN p.brand=r.subject_key
     WHEN 'CATEGORY' THEN p.category=r.subject_key
     WHEN 'TAG' THEN r.subject_key=ANY(p.tags)
     WHEN 'SUPPLIER' THEN EXISTS(SELECT 1 FROM supplier_items x WHERE x.workspace_id=$1 AND x.sku_id=p.sku_id AND x.supplier_id=r.supplier_id AND x.is_active=1)
     WHEN 'LOCATION' THEN EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=p.sku_id AND b.location_id=r.location_id)
       OR EXISTS(SELECT 1 FROM reorder_policies x WHERE x.workspace_id=$1 AND x.sku_id=p.sku_id AND x.location_id=r.location_id)
     ELSE false END
   LEFT JOIN active l ON l.id=r.location_id
   WHERE (r.location_id IS NULL OR l.id IS NOT NULL) AND ($2='' OR r.id=$2 OR lower(p.code)=lower($2))),
 stock AS (SELECT sc.*,coalesce((SELECT sum(b.on_hand) FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=sc.sku_id
     AND CASE WHEN sc.location_id IS NULL THEN b.location_id IN (SELECT id FROM active) ELSE b.location_id=sc.location_id END),0)::numeric AS value
   FROM scoped sc WHERE sc.condition IN ('STOCK_BELOW','STOCK_ABOVE','OUT_OF_STOCK')),
 sold AS (SELECT sc.*,coalesce((SELECT sum(d.issued) FROM stockchief_runtime.replenishment_demand_events d
     JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id AND m.reason_code IN ('sale','sold')
     WHERE d.workspace_id=$1 AND d.sku_id=sc.sku_id AND d.occurred_at>=now()-make_interval(days=>sc.days)
       AND (sc.location_id IS NULL OR d.location_id=sc.location_id)),0)::numeric AS value
   FROM scoped sc WHERE sc.condition='SALES_ABOVE'
     OR sc.condition='SALES_BELOW' AND EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=sc.sku_id))
 SELECT x.rule_id AS kind,x.code||coalesce(' at '||x.location,'') AS ref,'/inventory/'||x.item_id AS link,x.rule_id,x.instruction,x.condition,
   x.code AS sku,x.product,x.location,x.unit_label,x.value::text AS value,NULL::text AS before,NULL::text AS currency,NULL::text AS lot,NULL::text AS expires_on,x.days
 FROM stock x WHERE CASE x.condition WHEN 'OUT_OF_STOCK' THEN x.value<=0
   WHEN 'STOCK_BELOW' THEN x.value<x.amount OR x.inclusive AND x.value=x.amount ELSE x.value>x.amount OR x.inclusive AND x.value=x.amount END
 UNION ALL
 SELECT x.rule_id,x.code||coalesce(' at '||x.location,''),'/inventory/'||x.item_id,x.rule_id,x.instruction,x.condition,
   x.code,x.product,x.location,x.unit_label,x.value::text,NULL,NULL,NULL,NULL,x.days
 FROM sold x WHERE CASE x.condition WHEN 'SALES_BELOW' THEN x.value<x.amount OR x.inclusive AND x.value=x.amount
   ELSE x.value>x.amount OR x.inclusive AND x.value=x.amount END
 UNION ALL
 SELECT sc.rule_id,sc.code||' price '||latest.id,'/inventory/'||sc.item_id,sc.rule_id,sc.instruction,sc.condition,
   sc.code,sc.product,NULL,sc.unit_label,latest.amount_minor::text,earlier.amount_minor::text,latest.currency,NULL,latest.created_at::timestamptz::date::text,sc.days
 FROM scoped sc CROSS JOIN LATERAL (SELECT id,amount_minor,currency,created_at FROM sku_prices p WHERE p.workspace_id=$1 AND p.sku_id=sc.sku_id
   ORDER BY p.created_at DESC,p.id DESC LIMIT 1) latest
 CROSS JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices p WHERE p.workspace_id=$1 AND p.sku_id=sc.sku_id AND (p.created_at,p.id)<(latest.created_at,latest.id)
   ORDER BY p.created_at DESC,p.id DESC LIMIT 1) earlier
 WHERE sc.condition='PRICE_CHANGE' AND latest.created_at::timestamptz>=now()-make_interval(days=>sc.days)
   AND (latest.amount_minor IS DISTINCT FROM earlier.amount_minor OR latest.currency<>earlier.currency)
 UNION ALL
 SELECT sc.rule_id,sc.code||' batch '||lot.code||' at '||l.name,'/inventory/'||sc.item_id,sc.rule_id,sc.instruction,sc.condition,
   sc.code,sc.product,l.name,sc.unit_label,lb.quantity::text,NULL,NULL,lot.code,lot.expires_at::date::text,sc.days
 FROM scoped sc JOIN lots lot ON lot.workspace_id=$1 AND lot.sku_id=sc.sku_id AND lot.expires_at IS NOT NULL AND lot.recalled_at IS NULL
   AND lot.expires_at::date<=$3::date+sc.days
 JOIN lot_balances lb ON lb.workspace_id=$1 AND lb.lot_id=lot.id AND lb.quantity>0 AND (sc.location_id IS NULL OR lb.location_id=sc.location_id)
 JOIN active l ON l.id=lb.location_id
 WHERE sc.condition='EXPIRES_WITHIN'`;

// Brand watches on a database that has not run migration 460 yet.
const legacy=`SELECT 'Brand' AS kind,s.code AS ref,'/inventory/'||i.id AS link
  FROM stockchief_runtime.agent_brand_watches w JOIN catalogue_item_facts f ON f.workspace_id=w.workspace_id AND ${brandFact}=w.brand_key
  JOIN items i ON i.id=f.item_id AND i.workspace_id=w.workspace_id AND i.is_active=1
  JOIN skus s ON s.item_id=i.id AND s.workspace_id=w.workspace_id AND s.is_active=1
  CROSS JOIN LATERAL (SELECT coalesce(sum(b.on_hand),0) AS units FROM balances b WHERE b.workspace_id=w.workspace_id AND b.sku_id=s.id) q
  WHERE w.workspace_id=$1 AND (q.units<w.threshold OR (w.inclusive AND q.units=w.threshold))`;
async function candidates(db){
  return await require('../db/schema-installed').has(db,rules)
    ?' UNION ALL SELECT 167,kind,ref,link,$3::date FROM ('+sql+') watched':' UNION ALL SELECT 167,kind,ref,link,$3::date FROM ('+legacy+') watched';
}

const qty=(value,label)=>unitCount(Number(exact.canonical(String(value),{signed:true})),label);
function found(r){
  const money=minor=>require('../pricing/postgres-service').formatMinor(Number(minor),r.currency);
  if(r.condition==='PRICE_CHANGE')return 'Price changed from '+(r.before==null?'no price':money(r.before))+' to '+(r.value==null?'no price':money(r.value))+' on '+r.expires_on;
  if(r.condition==='EXPIRES_WITHIN')return 'Batch '+r.lot+': '+qty(r.value,r.unit_label)+' expire on '+r.expires_on;
  if(r.condition==='SALES_ABOVE'||r.condition==='SALES_BELOW')return qty(r.value,r.unit_label)+' sold in '+(r.days===1?'the last day':'the last '+r.days+' days');
  return qty(r.value,r.unit_label)+' on hand';
}
function describe(r){return {Rule:r.instruction,SKU:r.sku,Product:r.product,Location:r.location||'All locations',Found:found(r),link:r.link};}

async function review(db,ctx,{filter='',page=1,today}){
  if(!await require('../db/schema-installed').has(db,rules))return {rows:[],more:false,summary:'Watch rules are being upgraded. Check back shortly.'};
  const rows=(await db.query(`SELECT w.* FROM (${sql}) w JOIN ${rules} r ON r.workspace_id=$1 AND r.id=w.rule_id
    ORDER BY r.created_at,r.id,w.sku,w.ref LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter||'',today,(page-1)*100])).rows;
  return {rows:rows.slice(0,100).map(describe),more:rows.length>100,
    summary:'Products your watch rules match now. StockChief checks the rules through the day and clears an alert when its condition no longer holds.'};
}

// One plain line per alert, for the alert email.
async function lines(db,workspaceId,keys){
  const today=await require('../lib/business-time').today(db,workspaceId);
  const rows=(await db.query(`SELECT * FROM (${sql}) w`,[workspaceId,'',today])).rows;
  const byKey=new Map(rows.map(r=>[r.kind+'\u0000'+r.ref+'\u0000'+r.link,r]));
  return keys.map(k=>{const r=byKey.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);
    return r?r.sku+(r.location?' at '+r.location:'')+' ('+r.product+'). '+found(r)+'. Your rule: “'+r.instruction+'”':k.reference+'.';});
}

async function owner(db,ctx){
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the owner can change watch rules.');
}

// Finds what the rule names in the records. Asks back when the name is
// missing or could mean more than one thing.
const phrase={BRAND:n=>'“any '+n+' brand item”',CATEGORY:n=>'“any item in the '+n+' category”',SUPPLIER:n=>'“any item from supplier '+n+'”',
  LOCATION:n=>'“anything at '+n+'”',TAG:n=>'“any item tagged '+n+'”'};
const label={BRAND:'a brand',CATEGORY:'a category',SUPPLIER:'a supplier',LOCATION:'a location',TAG:'a tag'};
async function resolve(c,workspaceId,subject){
  if(subject.kind==='ALL')return {kind:'ALL',key:'',name:''};
  const name=subject.name,kinds=subject.kind?[subject.kind]:subject.kinds,matches=[];
  for(const kind of kinds){
    let rows;
    if(kind==='BRAND')rows=(await c.query(`SELECT trim($2) AS name FROM catalogue_item_facts f
      JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id AND i.is_active=1 WHERE f.workspace_id=$1 AND ${brandFact}=lower(trim($2)) LIMIT 1`,[workspaceId,name])).rows;
    else if(kind==='CATEGORY')rows=(await c.query(`SELECT trim($2) AS name FROM catalogue_item_facts f
      JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id AND i.is_active=1 WHERE f.workspace_id=$1 AND lower(trim(f.category))=lower(trim($2)) LIMIT 1`,[workspaceId,name])).rows;
    else if(kind==='TAG')rows=(await c.query(`SELECT trim($2) AS name FROM catalogue_item_facts f JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id AND i.is_active=1
      WHERE f.workspace_id=$1 AND lower(trim($2))=ANY(${tagsOf('f.facts::jsonb')}) LIMIT 1`,[workspaceId,name])).rows;
    else if(kind==='SUPPLIER')rows=(await c.query("SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(trim(name))=lower(trim($2)) ORDER BY id LIMIT 2",[workspaceId,name])).rows;
    else rows=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND lower(trim(name))=lower(trim($2)) ORDER BY id LIMIT 2',[workspaceId,name])).rows;
    if(rows.length>1)throw new ValidationError('More than one active '+kind.toLowerCase()+' is called “'+name+'”. Rename one of them first.');
    if(rows.length)matches.push({kind,row:rows[0]});
  }
  if(matches.length>1)throw new ValidationError('“'+name+'” is '+matches.map(m=>label[m.kind]).join(' and ')+'. Say which: '+matches.map(m=>phrase[m.kind](m.row.name)).join(' or ')+'.');
  if(!matches.length&&subject.whole){
    // "Brand 0" may be the whole name of a brand, not "brand 0".
    const whole=await resolve(c,workspaceId,{kinds:parser.KINDS,name:subject.whole}).catch(error=>{if(error instanceof ValidationError)return null;throw error;});
    if(whole)return whole;
  }
  if(!matches.length){
    if(subject.kind==='BRAND')throw new ValidationError('No active product has the brand “'+name+'”. Check the brand saved on the product.');
    if(subject.kind==='CATEGORY')throw new ValidationError('No active product is in the category “'+name+'”. Check the spelling.');
    if(subject.kind==='TAG')throw new ValidationError('No active product has the tag “'+name+'”. Check the spelling.');
    if(subject.kind==='SUPPLIER')throw new ValidationError('No active supplier is called “'+name+'”. Check the spelling.');
    if(subject.kind==='LOCATION')throw new ValidationError('No active location is called “'+name+'”. Check the spelling.');
    throw new ValidationError('No active product has the '+kinds.map(k=>label[k].slice(2)).join(', ').replace(/, ([^,]*)$/,' or $1')+' “'+name+'”. Check the spelling.');
  }
  const [{kind,row}]=matches;
  return {kind,key:['SUPPLIER','LOCATION'].includes(kind)?row.id:String(row.name).trim().toLowerCase(),name:String(row.name).trim(),
    supplierId:kind==='SUPPLIER'?row.id:null,locationId:kind==='LOCATION'?row.id:null};
}

// Saves a rule from the owner's words, or removes one (by rule, or by the
// brand, category, supplier, location or tag it watches).
async function save(db,ctx,input={}){
  return db.transaction(async c=>{
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    await owner(c,ctx);
    let result;
    if(input.remove){
      const target=String(input.remove).trim();
      const removed=(await c.query(`DELETE FROM ${rules} WHERE workspace_id=$1 AND enabled AND (id=$2 OR lower(subject_name)=lower($2)) RETURNING id,instruction`,
        [ctx.workspaceId,target])).rows;
      for(const rule of removed)await audit.record(c,ctx,{action:'Watch rule removed',reference:rule.id,before:{instruction:rule.instruction}});
      result={removed:removed.length};
    }else{
      const parsed=parser.parse(input.instruction);
      const subject=await resolve(c,ctx.workspaceId,parsed.subject);
      const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND enabled AND subject_kind=$2 AND subject_key=$3 AND condition=$4 FOR UPDATE`,
        [ctx.workspaceId,subject.kind,subject.key,parsed.condition])).rows[0];
      const same=prior&&prior.instruction===parsed.instruction&&(prior.amount==null?null:Number(prior.amount))===parsed.amount&&prior.inclusive===parsed.inclusive&&prior.days===parsed.days;
      if(same)return {saved:true,id:prior.id,meaning:parser.meaning(prior),unchanged:true};
      await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
      const id=prior?.id||newId('watch');
      await c.query(`INSERT INTO ${rules} AS w(id,workspace_id,instruction,subject_kind,subject_key,subject_name,supplier_id,location_id,condition,amount,inclusive,days,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        ON CONFLICT(id) DO UPDATE SET instruction=excluded.instruction,subject_name=excluded.subject_name,amount=excluded.amount,inclusive=excluded.inclusive,
          days=excluded.days,updated_by=excluded.updated_by,revision=w.revision+1,updated_at=clock_timestamp()`,
      [id,ctx.workspaceId,parsed.instruction,subject.kind,subject.key,subject.name,subject.supplierId,subject.locationId,parsed.condition,parsed.amount,parsed.inclusive,parsed.days,ctx.actorId]);
      const rule={subject_kind:subject.kind,subject_name:subject.name,condition:parsed.condition,amount:parsed.amount,inclusive:parsed.inclusive,days:parsed.days};
      await audit.record(c,ctx,{action:'Watch rule saved',reference:id,before:prior?{instruction:prior.instruction}:{},
        after:{instruction:parsed.instruction,meaning:parser.meaning(rule)}});
      result={saved:true,id,meaning:parser.meaning(rule)};
    }
    await require('./operational-notices').refresh(c,ctx.workspaceId);
    return result;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function list(db,workspaceId){
  if(!await require('../db/schema-installed').has(db,rules))return [];
  return (await db.query(`SELECT id,instruction,subject_kind,subject_name,condition,amount,inclusive,days,updated_at FROM ${rules}
    WHERE workspace_id=$1 AND enabled ORDER BY created_at,id`,[workspaceId])).rows.map(r=>({...r,meaning:parser.meaning(r)}));
}

module.exports={JOB,key,path,sql,candidates,review,lines,save,list,resolve,
  definition:{id:JOB,key,label:'Watch rules',filterLabel:'Exact SKU',readPage:review}};
