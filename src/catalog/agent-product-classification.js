'use strict';

// Job 131: suggests categories and tags for new products, and sets the clear
// ones on its own.
//
// A new product is an active product created in the last 30 days, whether it
// came from an import (job 127's supplier catalog included) or a person typed
// it in. The routine checks after each import, after a product is added, once
// a business day and on Check now.
//
// The rules are explicit and give the same answer every time. No AI model is
// used.
//  - Name words: the lower-case words of three or more letters in a product
//    name, without filler words such as "and" or "pack".
//  - A product that already has a category is similar to the new one when it
//    has the same brand; or the same supplier and a shared name word; or the
//    same material and a shared name word; or two shared name words.
//  - A category is clear when the product's own approved supplier file names
//    exactly one, or when at least two similar products all share one. It is
//    unclear when the file names several, when similar products disagree or
//    when only one similar product has a category. An unclear category waits
//    as a suggestion, its choices ranked by how many similar products use them.
//  - Tags are clear when they are the product's own recorded brand, material
//    or supplier-file tags, or when every one of at least two similar products
//    carries them. Tags that at least half (and at least two) of the similar
//    products carry, but not all, wait as a suggestion.
//
// Growth, Pro and Custom set clear categories and tags on their own inside the
// owner's daily limit and leave unclear ones as suggestions. Shadow mode,
// pause, watch mode, Watch only and Ask me first keep clear ones waiting too.
// Starter does not include the job. Every change is audited, written to the
// product's change history and can be undone; a suggestion the owner dismissed
// or a change they undid is not made again on its own.

const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {has}=require('../db/schema-installed');
const {hash}=require('../pricing/postgres-promotions');
const {newId,nowIso}=require('../lib/util');

const JOB=131,ACTION='catalog.classify_products',kind='agent.product-categories.v1',path='/autopilot/product-categories';
const NEW_DAYS=30,DEFAULT_DAILY=500,PAGE=200,PEER_PAGE=2000;
const records='stockchief_runtime.agent_product_classifications',rules='stockchief_runtime.agent_product_classification_rules';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>error instanceof DomainError&&[400,402,403,404,409].includes(error.status);
// Words that say nothing about what a product is.
const FILLER=new Set(['and','the','for','with','from','pack','packs','set','sets','new','each','pcs','piece','pieces','per','box','case','item','items',
  'product','products','size','sizes','small','medium','large','extra','one','two','three','four','five','six','ten','unit','units']);
// Supplier-file columns that name a category, tags, a brand or a material.
const SOURCE_KEYS=['brand','material','tag','tags','producttags','category','productcategory','producttype'];
const TAG_KEYS=['tags','tag','producttags'];

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the current inventory owner can set product categories and tags.');
}

async function access(db,ctx,{lock=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    if(reason)throw new ValidationError(reason);
  }
  return state;
}

// ---- What a product says about itself ---------------------------------------

const norm=key=>String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
function clean(value,max=240){
  const text=String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
  return text&&text.length<=max?text:null;
}
function split(value){
  if(Array.isArray(value))return value.flatMap(split);
  if(value&&typeof value==='object')return [];
  return String(value??'').split(',').map(v=>clean(v,80)).filter(Boolean);
}
function unique(values){const seen=new Map();for(const v of values)if(v&&!seen.has(v.toLowerCase()))seen.set(v.toLowerCase(),v);return [...seen.values()];}
function factsOf(raw){
  let value=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{value={};}}
  return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}
const factKey=(facts,names)=>Object.keys(facts).find(k=>names.includes(norm(k)));
function nameWords(name){
  return [...new Set(String(name||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'')
    .split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=3&&!/^\d+$/.test(w)&&!FILLER.has(w)))].sort();
}

// One query shape for new products, categorized products and single products.
async function profiles(db,workspaceId,{newOnly=false,categorized=false,ids=null,filter='',after='',limit=PAGE,offset=0}={}){
  return (await db.query(`SELECT i.id,i.name,coalesce(i.base_code,(SELECT min(s.code) FROM skus s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id)) AS code,
      f.category,f.facts,
      ARRAY(SELECT DISTINCT si.supplier_id FROM skus s JOIN supplier_items si ON si.workspace_id=s.workspace_id AND si.sku_id=s.id AND si.is_active=1
        WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id ORDER BY si.supplier_id) AS suppliers,
      (SELECT jsonb_agg(jsonb_build_array(e.key,e.value) ORDER BY sf.id,e.key) FROM skus s
        JOIN catalog_source_facts sf ON sf.workspace_id=s.workspace_id AND sf.sku_id=s.id
        JOIN import_plans ip ON ip.workspace_id=sf.workspace_id AND ip.id=sf.source_import_id AND ip.approval_status='APPROVED' AND ip.status IN ('SUCCEEDED','PARTIAL')
        CROSS JOIN LATERAL jsonb_each_text(coalesce(sf.attributes,jsonb_build_object(coalesce(sf.name,''),sf.value))) e
        WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id AND regexp_replace(lower(e.key),'[^a-z0-9]','','g')=ANY($6::text[])
          AND length(btrim(e.value)) BETWEEN 1 AND 240) AS source
    FROM items i LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id
    WHERE i.workspace_id=$1 AND i.is_active=1 AND i.id>$2
      AND (NOT $3::boolean OR i.created_at::timestamptz>=clock_timestamp()-make_interval(days=>${NEW_DAYS}))
      AND (NOT $4::boolean OR nullif(btrim(f.category),'') IS NOT NULL)
      AND ($5::text[] IS NULL OR i.id=ANY($5::text[]))
      AND ($7='' OR lower(i.base_code)=lower($7) OR lower(i.name)=lower($7)
        OR EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=i.workspace_id AND s.item_id=i.id AND lower(s.code)=lower($7)))
    ORDER BY i.id LIMIT $8 OFFSET $9`,[workspaceId,after,newOnly,categorized,ids,SOURCE_KEYS,filter,limit,offset])).rows;
}

function profile(row){
  const facts=factsOf(row.facts),source=row.source||[];
  const from=names=>source.filter(([k])=>names.includes(norm(k))).map(([,v])=>v);
  const single=values=>{const u=unique(values.map(v=>clean(v,120)).filter(Boolean));return u.length===1?u[0]:null;};
  const own=name=>{const key=factKey(facts,[name]);return key?clean(facts[key],120):null;};
  const tagKey=factKey(facts,TAG_KEYS);
  return {id:row.id,name:row.name,code:row.code||'',category:clean(row.category),
    brand:own('brand')||single(from(['brand'])),material:own('material')||single(from(['material'])),
    tags:unique(tagKey?split(facts[tagKey]):[]),sourceTags:unique(split(from(['tag','tags','producttags']))),
    sourceCategories:unique(from(['category','productcategory','producttype']).map(v=>clean(v)).filter(Boolean)),
    suppliers:row.suppliers||[],words:nameWords(row.name)};
}

// ---- Similar products ---------------------------------------------------------

// Every categorized product, indexed by brand, name word and supplier. Read
// once per run so a large import does not reread the catalog for each page.
async function peerIndex(db,workspaceId,{exclude=new Set()}={}){
  const index={brand:new Map(),word:new Map(),supplier:new Map()};
  const add=(map,key,p)=>{if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(p);};
  let after='';
  for(;;){
    const rows=await profiles(db,workspaceId,{categorized:true,after,limit:PEER_PAGE});
    for(const row of rows){
      if(exclude.has(row.id))continue;
      const p=profile(row);if(!p.category)continue;
      add(index.brand,p.brand?.toLowerCase(),p);
      for(const w of p.words)add(index.word,w,p);
      for(const s of p.suppliers)add(index.supplier,s,p);
    }
    if(rows.length<PEER_PAGE)break;
    after=rows.at(-1).id;
  }
  return index;
}

function similar(p,index){
  const candidates=new Map();
  for(const q of [...(p.brand?index.brand.get(p.brand.toLowerCase())||[]:[]),...p.words.flatMap(w=>index.word.get(w)||[]),
    ...p.suppliers.flatMap(s=>index.supplier.get(s)||[])])if(q.id!==p.id)candidates.set(q.id,q);
  const out=[];
  for(const q of [...candidates.values()].sort((a,b)=>a.id.localeCompare(b.id))){
    const shared=p.words.filter(w=>q.words.includes(w)).length;
    const reason=p.brand&&q.brand&&p.brand.toLowerCase()===q.brand.toLowerCase()?'brand':
      shared>=1&&p.suppliers.some(s=>q.suppliers.includes(s))?'supplier':
      shared>=1&&p.material&&q.material&&p.material.toLowerCase()===q.material.toLowerCase()?'material':
      shared>=2?'words':null;
    if(reason)out.push({peer:q,reason});
  }
  return out;
}

const basisText={brand:'the same brand',supplier:'the same supplier and name words',material:'the same material and name words',words:'shared name words'};
function basis(list){const r=[...new Set(list.map(s=>s.reason))];return r.length===1?basisText[r[0]]:'the same brand, supplier, material or name words';}
const plural=(n,one,many)=>n+' '+(n===1?one:many);

function option(type,details){
  const clear=type==='CATEGORY'?Boolean(details.category):details.tags.length>0&&!details.possible.length;
  const key=type==='CATEGORY'?{category:details.category||null,options:(details.options||[]).map(o=>o.category)}:{tags:details.tags,possible:details.possible};
  return {kind:type,itemId:details.itemId,clear,details,fingerprint:hash({item:details.itemId,kind:type,...key})};
}

// The category and tags this product should get, by the rules above.
function propose(p,list){
  const out=[],base={itemId:p.id,name:p.name,code:p.code};
  const examples=items=>items.slice(0,5).map(s=>({itemId:s.peer.id,code:s.peer.code,name:s.peer.name,category:s.peer.category}));
  if(!p.category){
    if(p.sourceCategories.length===1)out.push(option('CATEGORY',{...base,category:p.sourceCategories[0],evidence:'The supplier file lists this category.',examples:[]}));
    else if(p.sourceCategories.length>1)out.push(option('CATEGORY',{...base,options:p.sourceCategories.map(category=>({category,count:null})),
      evidence:'The supplier file lists '+p.sourceCategories.length+' different categories.',examples:[]}));
    else if(list.length){
      const groups=new Map();
      for(const s of list){const k=s.peer.category.toLowerCase(),g=groups.get(k)||{category:s.peer.category,count:0,forms:new Map()};
        g.count++;g.forms.set(s.peer.category,(g.forms.get(s.peer.category)||0)+1);groups.set(k,g);}
      // The most used spelling names the group; ties go to the first alphabetically.
      const ranked=[...groups.values()].map(g=>({category:[...g.forms.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0],count:g.count}))
        .sort((a,b)=>b.count-a.count||a.category.localeCompare(b.category));
      if(list.length>=2&&ranked.length===1)out.push(option('CATEGORY',{...base,category:ranked[0].category,
        evidence:list.length+' categorized products with '+basis(list)+' agree.',examples:examples(list)}));
      else out.push(option('CATEGORY',{...base,options:ranked,
        evidence:list.length===1?'Only one similar product has a category.':plural(list.length,'similar categorized product','similar categorized products')+' disagree.',
        examples:examples(list)}));
    }
  }
  const have=new Set(p.tags.map(t=>t.toLowerCase()));
  const own=unique([p.brand,p.material,...p.sourceTags].filter(Boolean)).filter(t=>!have.has(t.toLowerCase()));
  const counts=new Map();
  for(const s of list)for(const t of unique([...s.peer.tags,...s.peer.sourceTags])){const k=t.toLowerCase(),c=counts.get(k)||{tag:t,count:0};c.count++;counts.set(k,c);}
  const n=list.length,shared=[...counts.values()].filter(c=>n>=2&&c.count===n).map(c=>c.tag);
  const tags=unique([...own,...shared]).filter(t=>!have.has(t.toLowerCase())),taken=new Set(tags.map(t=>t.toLowerCase()));
  const possible=[...counts.values()].filter(c=>c.count>=2&&c.count*2>=n&&c.count<n&&!have.has(c.tag.toLowerCase())&&!taken.has(c.tag.toLowerCase()))
    .sort((a,b)=>b.count-a.count||a.tag.localeCompare(b.tag)).map(c=>c.tag);
  if(tags.length||possible.length){
    const said=[];
    if(own.length)said.push('Its own brand, material or supplier-file tags.');
    if(shared.length)said.push('All '+n+' similar products carry '+(shared.length===1?'this tag.':'these tags.'));
    if(possible.length)said.push('Most of '+n+' similar products carry '+(possible.length===1?'the tag marked maybe.':'the tags marked maybe.'));
    out.push(option('TAGS',{...base,tags,possible,evidence:said.join(' '),examples:examples(list)}));
  }
  return out;
}

// ---- Recording and authority --------------------------------------------------

async function record(c,workspaceId,o,{reason=null,wouldApply=false}={}){
  return (await c.query(`INSERT INTO ${records} AS r(id,workspace_id,item_id,kind,status,clear,details,fingerprint,reason,would_apply)
      VALUES($1,$2,$3,$4,'SUGGESTED',$5,$6::jsonb,$7,$8,$9)
    ON CONFLICT(workspace_id,item_id,kind) WHERE status='SUGGESTED' DO UPDATE SET clear=excluded.clear,details=excluded.details,
      fingerprint=excluded.fingerprint,reason=excluded.reason,would_apply=excluded.would_apply,checked_at=clock_timestamp()
    RETURNING *`,[newId('product-class'),workspaceId,o.itemId,o.kind,o.clear,JSON.stringify(o.details),o.fingerprint,reason,wouldApply])).rows[0];
}

// A suggestion the owner dismissed, or a change they undid, stays that way
// until the evidence changes.
async function closed(c,workspaceId,o){
  return (await c.query(`SELECT status FROM ${records} WHERE workspace_id=$1 AND item_id=$2 AND kind=$3 AND fingerprint=$4 AND status IN ('DISMISSED','UNDONE')
    ORDER BY decided_at DESC NULLS LAST LIMIT 1`,[workspaceId,o.itemId,o.kind,o.fingerprint])).rows[0]?.status||null;
}

async function loadRule(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT r.*,EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.id=r.authorized_by AND w.id=r.workspace_id AND u.role='owner') AS current
    FROM ${rules} r WHERE r.workspace_id=$1${lock?' FOR SHARE OF r':''}`,[workspaceId])).rows[0]||null;
}

async function gates(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {draft:false,account};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!person)return {draft:false,account};
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  let blocked=await policy.stopped(c,workspaceId,account,ACTION,true);
  if(!blocked&&!(await require('../autopilot/postgres-service').getState(c,workspaceId)).canAutomate)blocked='Handle routine work is off for this inventory.';
  return {draft:true,account,owner:person.id,blocked,workspaceId};
}

// Whether a clear change may be made without a person right now, and if not, why.
async function authority(c,gate,o){
  if(!policy.permits(gate.account.plan,JOB,'automatic'))return {reason:'A person approves each change on this plan.'};
  const rule=await loadRule(c,gate.workspaceId,{lock:true});
  if(rule&&!rule.enabled)return {reason:'You chose to approve every category and tag yourself.'};
  if(rule&&!rule.current)return {reason:'The daily limit was saved by someone who is no longer the owner. Save it again.'};
  const limit=rule?rule.daily_limit:DEFAULT_DAILY;
  const made=Number((await c.query(`SELECT count(*) FROM ${records} WHERE workspace_id=$1 AND status='DONE' AND automatic
    AND decided_at>clock_timestamp()-interval '1 day'`,[gate.workspaceId])).rows[0].count);
  if(made>=limit)return {reason:'This is over your limit of '+limit+' changes a day.'};
  if(await closed(c,gate.workspaceId,o)==='UNDONE')return {reason:'You undid this before. It waits for you now.'};
  return {rule};
}

// ---- Making the change --------------------------------------------------------

async function history(c,ctx,itemId,action,before,after){
  await c.query('INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state) VALUES($1,$2,$3,$4,NULL,$5,$6,$7)',
    [newId('catlog'),ctx.workspaceId,ctx.actorId,itemId,action,before,after]);
}
async function current(c,ctx,itemId){
  const item=(await c.query('SELECT id FROM items WHERE workspace_id=$1 AND id=$2 AND is_active=1 FOR UPDATE',[ctx.workspaceId,itemId])).rows[0];
  if(!item)throw new ValidationError('This product was archived. Nothing was changed.');
  return (await c.query('SELECT category,facts FROM catalogue_item_facts WHERE workspace_id=$1 AND item_id=$2 FOR UPDATE',[ctx.workspaceId,itemId])).rows[0]||null;
}
// Tags are written back in the form the product already uses: a list, or
// comma-separated text.
function withTags(facts,key,list,asText){return {...facts,[key]:asText?list.join(', '):list};}

async function act(c,ctx,rec,o,{automatic,value=null}){
  const ws=ctx.workspaceId,d=o.details,at=nowIso();let applied;
  const row=await current(c,ctx,d.itemId);
  if(o.kind==='CATEGORY'){
    const category=value??d.category;
    if(row&&clean(row.category))throw new ValidationError('A category was added to this product since. Nothing was changed.');
    await c.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,'{}',$4,$4)
      ON CONFLICT(workspace_id,item_id) DO UPDATE SET category=EXCLUDED.category,updated_at=EXCLUDED.updated_at`,[ws,d.itemId,category,at]);
    applied={before:row?row.category:null,after:category,createdFacts:!row};
    await history(c,ctx,d.itemId,'agent_category',{category:row?.category??null},{category,basis:value!==null&&value!==d.category?'person':d.evidence});
  }else{
    const facts=factsOf(row?.facts),key=factKey(facts,TAG_KEYS)||'tags',asText=typeof facts[key]==='string';
    const present=unique(split(facts[key]??[])),have=new Set(present.map(t=>t.toLowerCase()));
    const added=unique(value??d.tags).filter(t=>!have.has(t.toLowerCase()));
    if(!added.length)throw new ValidationError('These tags are already on the product. Nothing was changed.');
    await c.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,NULL,$3,$4,$4)
      ON CONFLICT(workspace_id,item_id) DO UPDATE SET facts=EXCLUDED.facts,updated_at=EXCLUDED.updated_at`,[ws,d.itemId,JSON.stringify(withTags(facts,key,[...present,...added],asText)),at]);
    applied={key,added,asText,createdFacts:!row};
    await history(c,ctx,d.itemId,'agent_tags',{tags:present},{tags:[...present,...added],added});
  }
  await c.query(`UPDATE ${records} SET status='DONE',automatic=$3,decided_by=$4,decided_at=clock_timestamp(),reason=NULL,would_apply=false,applied=$5
    WHERE workspace_id=$1 AND id=$2`,[ws,rec.id,automatic,ctx.actorId,JSON.stringify(applied)]);
  await audit.record(c,ctx,{action:automatic?'Product category or tags set on their own':'Product category or tags approved',reference:rec.id,
    after:{item:d.code||d.name,kind:o.kind,change:applied,evidence:d.evidence}});
  return {id:rec.id,kind:o.kind,applied};
}

// One proposal: make the clear part within the owner's limits, or leave it.
async function decide(c,gate,o){
  if(await closed(c,gate.workspaceId,o)==='DISMISSED')return 'dismissed';
  const mixed=o.kind==='TAGS'&&o.details.tags.length&&o.details.possible.length;
  const sure=mixed?option('TAGS',{...o.details,possible:[]}):o;
  if(!sure.clear){await record(c,gate.workspaceId,o);return 'suggested';}
  const allowed=await authority(c,gate,sure);
  if(allowed.reason||gate.blocked){await record(c,gate.workspaceId,o,{reason:allowed.reason||gate.blocked,wouldApply:true});return 'waiting';}
  const rec=await record(c,gate.workspaceId,sure);
  await c.query('SAVEPOINT product_classification');
  try{
    await act(c,{workspaceId:gate.workspaceId,actorId:gate.owner},rec,sure,{automatic:true});
    await c.query('RELEASE SAVEPOINT product_classification');
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT product_classification');
    await record(c,gate.workspaceId,o,{reason:error.message});
    return 'suggested';
  }
  if(mixed){const rest=option('TAGS',{...o.details,tags:[]});if(await closed(c,gate.workspaceId,rest)!=='DISMISSED')await record(c,gate.workspaceId,rest);}
  return 'done';
}

// ---- The routine --------------------------------------------------------------

async function run(job,database){
  const workspaceId=job.workspaceId,started=new Date().toISOString(),seen=new Set(),checked=new Set(),totals={done:0,suggested:0,waiting:0,dismissed:0};
  const first=await tx(database,c=>gates(c,workspaceId));
  if(!first.draft)return {skipped:true,...totals};
  const index=await peerIndex(database,workspaceId);
  let after='';
  for(let page=0;page<250;page++){
    const batch=await tx(database,async c=>{
      const gate=await gates(c,workspaceId);
      if(!gate.draft)return null;
      const rows=await profiles(c,workspaceId,{newOnly:true,after});
      for(const row of rows){
        const p=profile(row);checked.add(p.id);
        for(const o of propose(p,similar(p,index))){seen.add(o.kind+':'+p.id);totals[await decide(c,gate,o)]++;}
      }
      return {last:rows.at(-1)?.id,more:rows.length===PAGE};
    });
    if(!batch)return {skipped:true,...totals};
    if(!batch.last||!batch.more)break;
    after=batch.last;
  }
  // Suggestions for products that no longer need them, or were archived, close.
  await tx(database,async c=>{
    const open=(await c.query(`SELECT r.id,r.kind,r.item_id,i.is_active FROM ${records} r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id
      WHERE r.workspace_id=$1 AND r.status='SUGGESTED' AND r.checked_at<$2`,[workspaceId,started])).rows
      .filter(r=>!Number(r.is_active)||checked.has(r.item_id)&&!seen.has(r.kind+':'+r.item_id));
    if(open.length)await c.query(`UPDATE ${records} SET status='DISMISSED',reason='The product no longer needs this.',decided_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='SUGGESTED'`,[workspaceId,open.map(r=>r.id)]);
  });
  return totals;
}

async function enabled(c,workspaceId){
  const account=await policy.accountState(c,workspaceId);
  return policy.usesAgentTerms(account)&&policy.permits(account.plan,JOB,'draft');
}
const enqueue=(c,workspaceId,key,payload,priority)=>jobs.enqueue(scoped(c),{workspaceId,kind,idempotencyKey:key,payload,priority,maxAttempts:3});
// Once a business day, after each import and after a person adds a product.
async function schedule(c,workspaceId,cycleId){
  if(!await enabled(c,workspaceId))return {queued:false};
  const today=await require('../lib/business-time').today(c,workspaceId);
  return {queued:(await enqueue(c,workspaceId,'product-categories:day:'+today,{cycleId},70)).created};
}
async function afterImport(c,workspaceId,importId){
  if(!await enabled(c,workspaceId))return {queued:false};
  return {queued:(await enqueue(c,workspaceId,'product-categories:import:'+importId,{importId},60)).created};
}
async function afterCreate(c,workspaceId,itemId){
  if(!itemId||!await enabled(c,workspaceId))return {queued:false};
  return {queued:(await enqueue(c,workspaceId,'product-categories:item:'+itemId,{itemId},60)).created};
}
async function check(db,ctx){
  return tx(db,async c=>{
    await access(c,ctx,{lock:true});
    return {queued:(await enqueue(c,ctx.workspaceId,'product-categories:check:'+Math.floor(Date.now()/60000),{requestedBy:ctx.actorId},55)).created};
  });
}

// ---- A person's decisions -----------------------------------------------------

async function load(db,ctx,id,{lock=false}={}){
  const row=(await db.query(`SELECT * FROM ${records} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That category or tag suggestion is not in this inventory.');
  return row;
}

// The value a person chose: a listed category or one they typed, or the tags
// they ticked.
function chosen(rec,input,{bulk=false}={}){
  const d=rec.details;
  if(rec.kind==='CATEGORY'){
    const typed=String(input.category??'').trim();
    if(typed){const value=clean(typed);if(!value)throw new ValidationError('Enter a category of up to 240 characters.');return value;}
    if(input.choice!==undefined&&input.choice!==''){
      const pick=(d.options||[])[Number(input.choice)];
      if(!Number.isSafeInteger(Number(input.choice))||!pick)throw new ValidationError('Choose one of the listed categories, or type one.');
      return pick.category;
    }
    if(d.category)return d.category;
    if(bulk&&d.options?.length)return d.options[0].category;
    throw new ValidationError('Choose a category, or type one.');
  }
  const offered=[...d.tags,...d.possible];
  // The page always says the person ticked; without that, the clear tags are meant.
  if(input.tag===undefined&&input.ticked!=='yes'){
    if(bulk)return d.tags.length?d.tags:d.possible;
    if(d.tags.length)return d.tags;
  }
  const ticked=[...new Set((Array.isArray(input.tag)?input.tag:[input.tag]).filter(t=>t!==undefined&&t!=='').map(String))];
  const picks=ticked.map(t=>offered.find(o=>o.toLowerCase()===t.toLowerCase()));
  if(!ticked.length)throw new ValidationError('Tick the tags to add.');
  if(picks.some(p=>!p))throw new ValidationError('Tick tags from the suggestion.');
  return picks;
}

async function approveIn(c,ctx,id,input,{bulk=false}={}){
  const rec=await load(c,ctx,id,{lock:true});
  if(rec.status==='DONE'&&input.fingerprint===rec.fingerprint)return {replayed:true,id:rec.id};
  if(rec.status!=='SUGGESTED')throw new ValidationError('This suggestion is no longer waiting for you.');
  if(input.confirmed!=='yes'||input.fingerprint!==rec.fingerprint)throw new ValidationError('Review the current suggestion and confirm it.');
  const value=chosen(rec,input,{bulk});
  return act(c,ctx,rec,{kind:rec.kind,details:rec.details},{automatic:false,value});
}
async function approve(database,ctx,id,input={}){
  return tx(database,async c=>{await access(c,ctx,{lock:true,stop:true});return approveIn(c,ctx,id,input);});
}
// The ticked suggestions, each with its first choice.
async function approveMany(database,ctx,input={}){
  const ticked=[...new Set((Array.isArray(input.pick)?input.pick:[input.pick]).filter(Boolean).map(String))];
  if(!ticked.length||ticked.length>200)throw new ValidationError('Tick between 1 and 200 suggestions to approve.');
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the suggestions you ticked.');
  return tx(database,async c=>{
    await access(c,ctx,{lock:true,stop:true});
    const result={done:0,failed:[]};
    for(const entry of ticked){
      const [id,fingerprint]=entry.split(':');
      await c.query('SAVEPOINT product_classification_bulk');
      try{
        const done=await approveIn(c,ctx,id,{confirmed:'yes',fingerprint},{bulk:true});
        await c.query('RELEASE SAVEPOINT product_classification_bulk');
        if(!done.replayed)result.done++;
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT product_classification_bulk');
        result.failed.push({id,reason:error.message});
      }
    }
    if(result.done)await audit.record(c,ctx,{action:'Product categories and tags approved in bulk',reference:'product-categories',after:{approved:result.done,stopped:result.failed.length}});
    return result;
  });
}

async function dismiss(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const rec=await load(c,ctx,id,{lock:true});
    if(rec.status==='DISMISSED')return {replayed:true};
    if(rec.status!=='SUGGESTED')throw new ValidationError('This suggestion is no longer waiting for you.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that the product stays as it is.');
    await c.query(`UPDATE ${records} SET status='DISMISSED',reason='You kept the product as it is.',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Product category or tags dismissed',reference:id,after:{kind:rec.kind,item:rec.details.code||rec.details.name}});
    return {dismissed:true};
  });
}

// A change can be undone while the product still shows what it set.
async function undoable(db,ctx,rec){
  if(rec.status!=='DONE')return false;
  const row=(await db.query('SELECT f.category,f.facts FROM catalogue_item_facts f JOIN items i ON i.workspace_id=f.workspace_id AND i.id=f.item_id WHERE f.workspace_id=$1 AND f.item_id=$2',
    [ctx.workspaceId,rec.item_id])).rows[0];
  if(!row)return false;
  if(rec.kind==='CATEGORY')return row.category===rec.applied.after;
  const facts=factsOf(row.facts),present=new Set(split(facts[rec.applied.key]??[]).map(t=>t.toLowerCase()));
  return rec.applied.added.some(t=>present.has(t.toLowerCase()));
}

async function undo(database,ctx,id,input={}){
  return tx(database,async c=>{
    await access(c,ctx,{lock:true});
    const rec=await load(c,ctx,id,{lock:true});
    if(rec.status==='UNDONE')return {replayed:true};
    if(rec.status!=='DONE')throw new ValidationError('Only a change that was made can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this change is undone.');
    const a=rec.applied,ws=ctx.workspaceId;
    const row=(await c.query('SELECT category,facts FROM catalogue_item_facts WHERE workspace_id=$1 AND item_id=$2 FOR UPDATE',[ws,rec.item_id])).rows[0];
    if(rec.kind==='CATEGORY'){
      if(!row||row.category!==a.after)throw new ValidationError('The category changed after this. Change it on the product.');
      await c.query('UPDATE catalogue_item_facts SET category=$3,updated_at=$4 WHERE workspace_id=$1 AND item_id=$2',[ws,rec.item_id,a.before,nowIso()]);
      await history(c,ctx,rec.item_id,'agent_category_undone',{category:a.after},{category:a.before});
    }else{
      const facts=factsOf(row?.facts),present=unique(split(facts[a.key]??[])),drop=new Set(a.added.map(t=>t.toLowerCase()));
      const kept=present.filter(t=>!drop.has(t.toLowerCase()));
      if(!row||kept.length===present.length)throw new ValidationError('These tags were already removed from the product.');
      await c.query('UPDATE catalogue_item_facts SET facts=$3,updated_at=$4 WHERE workspace_id=$1 AND item_id=$2',[ws,rec.item_id,JSON.stringify(withTags(facts,a.key,kept,a.asText)),nowIso()]);
      await history(c,ctx,rec.item_id,'agent_tags_undone',{tags:present},{tags:kept});
    }
    await c.query(`UPDATE ${records} SET status='UNDONE',decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ws,id]);
    await audit.record(c,ctx,{action:'Product category or tags undone',reference:id,after:{kind:rec.kind,item:rec.details.code||rec.details.name,automatic:rec.automatic}});
    return {undone:true,kind:rec.kind};
  });
}

// The owner's daily limit for changes made without a person.
async function configure(database,ctx,input={}){
  return tx(database,async c=>{
    await owner(c,ctx,{lock:true});
    const state=await policy.accountState(c,ctx.workspaceId);
    policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'automatic');
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the page to see the current limit.');
    if(input.stop==='yes'){
      if(!prior||prior.enabled){
        await c.query(`INSERT INTO ${rules} AS r(workspace_id,enabled,daily_limit,authorized_by) VALUES($1,false,$2,$3)
          ON CONFLICT(workspace_id) DO UPDATE SET enabled=false,revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,DEFAULT_DAILY,ctx.actorId]);
        await audit.record(c,ctx,{action:'Product category limit stopped',reference:'product-categories'});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the limit before saving it.');
    const limit=Number(String(input.dailyLimit??'').trim());
    if(!Number.isSafeInteger(limit)||limit<1||limit>5000)throw new ValidationError('Enter how many products a day, from 1 to 5,000.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,daily_limit,authorized_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,daily_limit=excluded.daily_limit,authorized_by=excluded.authorized_by,
      revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,limit,ctx.actorId]);
    await enqueue(c,ctx.workspaceId,'product-categories:rule:'+((prior?.revision||0)+1),{},55);
    await audit.record(c,ctx,{action:'Product category limit saved',reference:'product-categories',
      before:prior?{enabled:prior.enabled,dailyLimit:prior.daily_limit}:{},after:{dailyLimit:limit}});
    return {saved:true};
  });
}

// ---- Pages --------------------------------------------------------------------

function describe(rec){
  const d=rec.details;
  if(rec.kind==='CATEGORY')return d.category?'Category: '+d.category:'Category: choose '+d.options.map(o=>o.category+(o.count?' ('+o.count+')':'')).join(', ');
  return 'Tags: '+[...d.tags,...d.possible.map(t=>t+' (maybe)')].join(', ');
}
function doneText(rec){
  const a=rec.applied;
  return rec.kind==='CATEGORY'?'Category set to '+a.after+(a.before?' (was '+a.before+')':'')+'.':'Tags added: '+a.added.join(', ')+'.';
}
const labels={SUGGESTED:'Waiting',DONE:'Done',DISMISSED:'Kept as it is',UNDONE:'Undone'};

async function page(db,ctx,{page:number=1}={}){
  const state=await access(db,ctx);
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>1000000)throw new ValidationError('Choose a valid page.');
  const waiting=(await db.query(`SELECT * FROM ${records} WHERE workspace_id=$1 AND status='SUGGESTED'
    ORDER BY would_apply DESC,(details->>'name'),kind,id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const recent=(await db.query(`SELECT * FROM ${records} WHERE workspace_id=$1 AND status IN ('DONE','UNDONE') ORDER BY decided_at DESC,id LIMIT 25`,[ctx.workspaceId])).rows;
  const done=[];
  for(const r of recent)done.push({...r,text:doneText(r),label:r.status==='UNDONE'?'Undone':r.automatic?'Set on its own':'Approved by you',undoable:await undoable(db,ctx,r)});
  const rule=await loadRule(db,ctx.workspaceId);
  const automatic=policy.permits(state.plan,JOB,'automatic');
  const stop=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  return {stop,page:number,more:waiting.length>50,automatic,rule,on:automatic&&(!rule||rule.enabled),dailyLimit:rule?.daily_limit||DEFAULT_DAILY,
    waiting:waiting.slice(0,50).map(r=>({...r,text:describe(r),label:labels[r.status]})),done};
}

async function inbox(db,workspaceId){
  if(!await has(db,records))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const row=(await db.query(`SELECT count(*)::int AS waiting,count(DISTINCT item_id)::int AS products,min(created_at) AS at
    FROM ${records} WHERE workspace_id=$1 AND status='SUGGESTED'`,[workspaceId])).rows[0];
  if(!row.waiting)return [];
  return [{kind:'catalog',importance:'Needs You',priority:40,grouped:true,title:'New products need a category or tags',
    happened:plural(row.products,'new product has','new products have')+' a category or tags waiting for you.',
    why:'Categories and tags drive filters, reports, watch rules and promotions.',
    recommendation:'Approve the suggestions, pick a category where similar products disagree, or keep the product as it is.',
    href:path,actionLabel:'Review categories and tags',sourceId:'product-categories',at:row.at,createdAt:row.at}];
}

// The live review behind the agent reviews list and Ask. Shows what the rules
// suggest now for new products, or for the product asked about, and what is
// already waiting or done.
async function review(db,ctx,{filter='',page=1}={}){
  const shown=await profiles(db,ctx.workspaceId,{newOnly:!filter,filter,limit:101,offset:(page-1)*100});
  const index=shown.length?await peerIndex(db,ctx.workspaceId):null;
  const status=new Map();
  if(shown.length&&await has(db,records))for(const r of (await db.query(`SELECT DISTINCT ON (item_id,kind) item_id,kind,status,automatic FROM ${records}
      WHERE workspace_id=$1 AND item_id=ANY($2::text[]) ORDER BY item_id,kind,created_at DESC,id DESC`,[ctx.workspaceId,shown.map(r=>r.id)])).rows)
    status.set(r.item_id+':'+r.kind,r.status==='DONE'?(r.automatic?'Set on its own':'Approved'):labels[r.status]);
  return {more:shown.length>100,summary:'Categories come from the product’s own supplier file, or from similar products (same brand, supplier, material or name words) that all agree. Clear ones are set on their own; unclear ones wait for you.',
    rows:shown.slice(0,100).map(row=>{
      const p=profile(row),list=similar(p,index),found=propose(p,list);
      const cat=found.find(o=>o.kind==='CATEGORY'),tags=found.find(o=>o.kind==='TAGS');
      return {Product:p.name,Code:p.code,'Suggested category':cat?.details.category||null,
        'Possible categories':cat&&!cat.details.category?cat.details.options.map(o=>o.category).join(', '):null,
        'Suggested tags':tags?.details.tags.join(', ')||null,'Possible tags':tags?.details.possible.join(', ')||null,
        Evidence:cat?.details.evidence||(p.category?'Already has a category':'More product evidence needed'),
        Status:[cat&&status.get(p.id+':CATEGORY'),tags&&status.get(p.id+':TAGS')].filter(Boolean).join(', ')||null,
        'Similar products':list.slice(0,3).map(s=>s.peer.code||s.peer.name).join(', ')||null,link:'/inventory/'+p.id};
    })};
}

// Product page: what StockChief set on this product, with a way to undo it.
async function notes(db,workspaceId,itemId){
  if(!await has(db,records))return [];
  return (await db.query(`SELECT id,kind,applied,automatic,decided_at FROM ${records} WHERE workspace_id=$1 AND item_id=$2 AND status='DONE'
    ORDER BY decided_at DESC,id LIMIT 5`,[workspaceId,itemId])).rows.map(r=>({...r,text:doneText(r)}));
}

const definition={id:JOB,key:'product-categories',label:'Suggest categories and tags for new products',readPage:review};

module.exports={JOB,ACTION,kind,path,NEW_DAYS,DEFAULT_DAILY,nameWords,profile,similar,propose,run,schedule,afterImport,afterCreate,check,
  approve,approveMany,dismiss,undo,configure,page,inbox,review,notes,load,definition};
