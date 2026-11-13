'use strict';
// Job 84: answers stock and delivery questions in the owner's website chat,
// inside the owner's rules: which products, which locations count, and whether
// visitors see exact numbers or only "in stock", "low" and "out of stock".
// It never shares costs, other customers' data or anything private; anything
// outside the rules goes to a person. Every answer is in the audit trail.
const {randomBytes,createHash}=require('node:crypto'),{newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions'),policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError,RateLimitError}=require('../domain/errors'),action='website.answer_stock';
const audit=(db,ctx,entry)=>require('../operations/postgres-security-audit').record(db,ctx,entry);
const tokenHash=v=>createHash('sha256').update(v).digest('hex'),tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const HANDOFFS='stockchief_runtime.agent_website_chat_handoffs';
// Abuse limits for the public endpoint, on top of the per-address request limit
// in the route: answers per assistant per hour, questions sent to a person per
// assistant per hour and per visitor per hour, and open questions per inventory.
const LIMITS={answersPerHour:600,handoffsPerHour:30,handoffsPerVisitor:3,openHandoffs:500,locations:20};
// Questions about these are never answered here: costs, margins, suppliers,
// customers, invoices, payments and other money stay private. Order questions
// without a product code go to the team as outside the rules.
const PRIVATE=/\b(?:costs?|cost price|margins?|profits?|markups?|wholesale|suppliers?|vendors?|manufacturers?|customers?|clients?|buyers?|bought|purchased|invoices?|accounts?|balances?|debts?|owes?|owed|payments?|paid|refunds?|revenue|sales figures?|turnover|valuation|stock value|value of stock)\b/i;
const DELIVERY=/\b(delivery|deliver|shipping|ship|dispatch|arrive|arrival|pickup|collection|collect)\b/i;
function paragraph(v){if(typeof v!=='string'||!v.trim()||v.trim().length>600||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))throw new ValidationError('Enter your checked public delivery answer, up to 600 characters.');return v.replace(/\r\n?/g,'\n').trim();}
function text(v,label,max=600){if(typeof v!=='string'||!v.trim()||v.trim().length>max||/[\u0000-\u001f\u007f]/.test(v))throw new ValidationError('Enter '+label+' on one plain line, up to '+max+' characters.');return v.trim();}
function origins(raw){const values=(Array.isArray(raw)?raw:String(raw||'').split(/\r?\n/)).map(s=>String(s).trim()).filter(Boolean);if(values.length>10)throw new ValidationError('Choose up to ten exact website origins.');return [...new Set(values.map(s=>{let u;try{u=new URL(s);}catch{throw new ValidationError('Use an exact HTTPS website origin, such as https://shop.example.com.');}if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||(!/^[a-z0-9.-]+$/i.test(u.hostname)&&!/^\[[a-f0-9:]+\]$/i.test(u.hostname))||u.protocol!=='https:'&&!(process.env.NODE_ENV==='test'&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new ValidationError('Use exact HTTPS origins without paths, credentials or wildcards.');return u.origin;}))];}
// The locations an assistant counts. An assistant published with one location
// keeps its original stored shape, so its published scope still matches.
const placesOf=p=>Array.isArray(p.location_ids)&&p.location_ids.length?p.location_ids.map(String):[String(p.location_id)];
function lowAt(raw){if(raw===undefined||raw===null||String(raw).trim()==='')return null;const n=Number(String(raw).trim());if(!Number.isSafeInteger(n)||n<1||n>1000000)throw new ValidationError('Enter the “low stock” level as a whole number from 1 to 1,000,000, or leave it empty.');return n;}
async function owner(c,ctx,lock=false,accountLock=false){if(!(await c.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)${lock?' FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can publish website stock answers.');await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);if(accountLock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);}
// Answers need Pro or Custom, the watch period over, routine work allowed and
// the job not paused or on Watch only. With the job on "Ask me first" a person
// answers each question, so every question is offered to the team instead.
async function access(c,ctx,{automatic=false,lock=false}={}){if(lock)await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);const a=await policy.requireWorkspaceJob(c,ctx.workspaceId,84,automatic?'automatic':'draft');await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');if(automatic){if(lock)await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);const reason=await policy.stopped(c,ctx.workspaceId,a,action,true);if(reason===require('../autopilot/job-modes').ASK_FIRST)return {askFirst:true};if(reason)throw new ValidationError(reason);if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Public stock answers are paused by the owner.');}return {askFirst:false};}
async function facts(c,ctx,p){
 const ids=placesOf(p);if(!ids.length||ids.length>LIMITS.locations||new Set(ids).size!==ids.length)throw new ValidationError('Choose one to '+LIMITS.locations+' internal stock locations.');
 const places=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,ids])).rows;if(places.length!==ids.length)throw new ValidationError('Choose an active internal stock location.');
 if(!Array.isArray(p.sku_ids)||!p.sku_ids.length||p.sku_ids.length>1000||new Set(p.sku_ids).size!==p.sku_ids.length)throw new ValidationError('Publish one to 1,000 distinct whole-unit products.');
 const products=(await c.query(`SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 AND i.tracking_mode='quantity' AND i.quantity_precision=0 AND i.secondary_unit_label IS NULL
 AND NOT EXISTS(SELECT 1 FROM kit_components k WHERE k.workspace_id=s.workspace_id AND k.kit_sku_id=s.id) ORDER BY s.id`,[ctx.workspaceId,p.sku_ids])).rows;
 if(products.length!==p.sku_ids.length)throw new ValidationError('Review inactive products, kits or tracked/measured goods separately.');const source=Array.isArray(p.location_ids)&&p.location_ids.length?{locationIds:[...ids].sort(),products}:{locationId:ids[0],products};return {...source,sourceHash:hash(source)};
}
async function profile(c,ctx,id,lock=false){const p=(await c.query('SELECT * FROM stockchief_runtime.agent_website_stock_chats WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];if(!p)throw new NotFoundError('That website stock assistant is not in this inventory.');return p;}
function chosenPlaces(input){const raw=input.locationIds??input.locationId;const list=(Array.isArray(raw)?raw:[raw]).map(v=>String(v??'').trim()).filter(Boolean);if(!list.length)throw new ValidationError('Choose at least one stock location that counts.');return [...new Set(list)];}
async function publish(db,ctx,input){return tx(db,async c=>{
 await owner(c,ctx,true,true);await access(c,ctx,{lock:true});const prior=input.id?await profile(c,ctx,input.id,true):null;if(prior&&Number(input.revision)!==prior.revision)throw new ValidationError('Reload the current website stock assistant before changing it.');
 if(input.confirmed!=='yes')throw new ValidationError('Confirm publishing only these products, stock visibility, exact website origins and the checked public delivery answer.');
 let ids=input.skuIds;if(!ids){const codes=String(input.skuCodes||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!codes.length||codes.length>1000||new Set(codes).size!==codes.length)throw new ValidationError('Enter one to 1,000 distinct exact SKU codes.');const rows=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[])',[ctx.workspaceId,codes])).rows;if(rows.length!==codes.length)throw new ValidationError('Match every exact product code in this inventory.');ids=rows.map(r=>r.id);}
 const places=chosenPlaces(input),p={location_id:places[0],location_ids:places.length>1?[...places].sort():null,sku_ids:ids},f=await facts(c,ctx,p),label=text(input.label,'the public assistant title',120),delivery=paragraph(input.deliveryAnswer),allowedOrigins=origins(input.embedOrigins),showQuantity=input.showQuantity==='yes',low=showQuantity?null:lowAt(input.lowStockAt),id=prior?.id||newId('stock-chat'),token=randomBytes(32).toString('base64url');
 if((await c.query('SELECT 1 FROM stockchief_runtime.agent_website_stock_chats WHERE workspace_id=$1 AND label=$2 AND id<>$3',[ctx.workspaceId,label,id])).rowCount)throw new ValidationError('This assistant title already exists. Revise its existing scope or choose a different title.');
 await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'website-stock-chat:'+id,Buffer.byteLength(JSON.stringify(f))+16384,{finished:true});
 const values=[ctx.workspaceId,id,p.location_id,label,JSON.stringify(ids),JSON.stringify(f),f.sourceHash,delivery,showQuantity,JSON.stringify(allowedOrigins),tokenHash(token),ctx.actorId,p.location_ids?JSON.stringify(p.location_ids):null,low];
 if(prior)await c.query('UPDATE stockchief_runtime.agent_website_stock_chats SET location_id=$3,label=$4,sku_ids=$5::jsonb,source_snapshot=$6::jsonb,source_hash=$7,delivery_answer=$8,show_quantity=$9,embed_origins=$10::jsonb,token_hash=$11,authorized_by=$12,location_ids=$13::jsonb,low_stock_at=$14,enabled=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2',values);
 else await c.query('INSERT INTO stockchief_runtime.agent_website_stock_chats(workspace_id,id,location_id,label,sku_ids,source_snapshot,source_hash,delivery_answer,show_quantity,embed_origins,token_hash,authorized_by,location_ids,low_stock_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14)',values);
 await audit(c,ctx,{action:'Public website stock answers authorized for exact scope',reference:id,after:{products:ids,locationIds:places,showQuantity,lowStockAt:low,embedOrigins:allowedOrigins,deliveryAnswer:delivery,previousLinkRevoked:Boolean(prior),trainingRequired:false}});return {id,token};
 });}
async function stop(db,ctx,id,input){return tx(db,async c=>{await owner(c,ctx,true,true);const p=await profile(c,ctx,id,true);if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the current assistant before stopping it.');await c.query('UPDATE stockchief_runtime.agent_website_stock_chats SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);await audit(c,ctx,{action:'Public website stock answers stopped',reference:id});return {id};});}
async function metadata(c,token,{lock=false}={}){if(typeof token!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(token))return null;return (await c.query('SELECT id,workspace_id,location_id,location_ids,low_stock_at,label,sku_ids,source_hash,delivery_answer,show_quantity,embed_origins,enabled,authorized_by,revision FROM stockchief_runtime.agent_website_stock_chats WHERE token_hash=$1'+(lock?' FOR SHARE':''),[tokenHash(token)])).rows[0]||null;}
function identify(products,question){const q=String(question||'').toLocaleLowerCase('en-US');return products.filter(p=>{const code=p.code.toLocaleLowerCase('en-US'),escaped=code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return q===code||q===p.name.toLocaleLowerCase('en-US')||new RegExp('(?:^|[^\\p{L}\\p{N}_-])'+escaped+'(?:$|[^\\p{L}\\p{N}_-])','u').test(q);});}
// One more answer or hand-off this hour, within the assistant's hourly allowance.
async function count(db,p,kind){const max=kind==='handoffs'?LIMITS.handoffsPerHour:LIMITS.answersPerHour;
 const row=(await db.query(`INSERT INTO stockchief_runtime.agent_website_chat_usage AS u(workspace_id,chat_id,hour,${kind}) VALUES($1,$2,date_trunc('hour',clock_timestamp()),1)
  ON CONFLICT(chat_id,hour) DO UPDATE SET ${kind}=u.${kind}+1 WHERE u.${kind}<$3 RETURNING ${kind}`,[p.workspace_id,p.id,max])).rows[0];
 if(!row)throw new RateLimitError(kind==='handoffs'?'The team has many questions right now. Please contact the business directly.':'This assistant is busy right now. Please try again later.');}
const visitorKey=(p,visitor)=>createHash('sha256').update(p.id+':'+String(visitor||'unknown')).digest('hex');
async function answer(db,token,raw,{lock=false,visitor=null}={}){
 const p=await metadata(db,token,{lock});if(!p?.enabled)throw new NotFoundError('This stock assistant is unavailable.');const ctx={workspaceId:p.workspace_id,actorId:p.authorized_by};await owner(db,ctx,lock);const {askFirst}=await access(db,ctx,{automatic:true,lock});const f=await facts(db,ctx,p);if(f.sourceHash!==p.source_hash)throw new ValidationError('The published product scope changed and needs owner review.');
 const question=String(raw||'').trim();if(question.length>200||/[\u0000-\u001f\u007f]/.test(question))throw new ValidationError('Use a product code or ask about the public delivery policy, up to 200 characters.');
 const delivery=DELIVERY.test(question),matches=identify(f.products,question);const result={title:p.label,question,reply:'Enter an exact product code, or ask about the public delivery policy.',delivery:delivery?p.delivery_answer:null,quantity:null,available:null,band:null,code:null,suggestions:[],handoff:null};
 if(!question)return result;
 await count(db,p,'answers');
 const outcome=async(kind,extra={})=>{await audit(db,{workspaceId:p.workspace_id},{action:'Website stock question answered',reference:p.id,after:{question,outcome:kind,code:result.code,band:result.band,quantityShown:result.quantity!==null,handedOff:Boolean(result.handoff),...extra}});return result;};
 const handOff=(reply,reason)=>{result.reply=reply;result.delivery=null;result.handoff={reason};};
 if(askFirst){handOff('A person on the team answers these questions. Send yours and they will reply.','The owner answers each website question personally (Ask me first).');return outcome('handed_off');}
 if(PRIVATE.test(question)){handOff('I can’t share that here. I only answer about the published product codes and the public delivery policy. You can send your question to the team.','Asks about something the assistant does not share, such as costs, customers, orders or payments.');return outcome('private');}
 if(matches.length!==1){if(matches.length>1){result.reply='Which product do you mean? Use one exact product code.';result.suggestions=matches.slice(0,5).map(s=>s.code);return outcome('clarify');}if(delivery){result.reply=p.delivery_answer;return outcome('delivery');}handOff('I can answer for the published product codes and the business’s checked public delivery policy. Please use an exact product code, or send your question to the team.','Outside the published products and delivery policy.');return outcome('outside_rules');}
 const product=matches[0];result.code=product.code;
 const withheld=reply=>{handOff(reply,'Stock for '+product.code+' needs a person to confirm.');result.code=product.code;return outcome('withheld');};
 if((await db.query("SELECT 1 FROM stockchief_runtime.agent_annual_stocktakes WHERE workspace_id=$1 AND status='FROZEN' LIMIT 1",[ctx.workspaceId])).rowCount)return withheld('Please contact the business to confirm availability while stock checks are in progress.');
 let available=0;
 for(const locationId of placesOf(p)){
  const stock=await require('../domain/postgres-stock-availability').read(db,ctx.workspaceId,product.id,locationId),cost=(await db.query('SELECT quantity_units::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,product.id,locationId])).rows[0];
  if(stock.onHand>0&&(!cost||Number(cost.quantity_units)<stock.onHand)||!Number.isSafeInteger(stock.available))return withheld('Please contact the business to confirm this product’s current availability.');
  available+=Math.max(0,stock.available);
 }
 result.available=available>0;result.band=!result.available?'out':p.low_stock_at&&!p.show_quantity&&available<=p.low_stock_at?'low':'in_stock';result.quantity=p.show_quantity?available:null;
 result.reply=product.code+(result.band==='low'?' is available to request, but stock is low.':result.available?' is available to request.':' is not currently available to request.')+(p.show_quantity?' Available quantity: '+available+'.':'');return outcome('stock');
}
// A question outside the rules, sent by the visitor to the team. Only the
// assistant's own judgement of the question is kept as the reason; a filled
// hidden field (left by form-filling robots) is accepted and dropped.
async function handoff(db,token,input={},{visitor=null}={}){return tx(db,async c=>{
 const p=await metadata(c,token,{lock:true});if(!p?.enabled)throw new NotFoundError('This stock assistant is unavailable.');const ctx={workspaceId:p.workspace_id,actorId:p.authorized_by};await owner(c,ctx,true);const {askFirst}=await access(c,ctx,{automatic:true,lock:true});
 const question=String(input.question||'').replace(/\s+/g,' ').trim();if(!question||question.length>500||/[\u0000-\u001f\u007f]/.test(question))throw new ValidationError('Write your question in up to 500 characters.');
 const contact=String(input.contact||'').trim();if(contact&&(contact.length>200||!(/^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/.test(contact)||/^\+?[0-9][0-9 ()-]{6,24}$/.test(contact))))throw new ValidationError('Leave an email address or phone number for the reply, or leave it empty.');
 if(String(input.website||'').trim())return {id:null};
 const key=visitorKey(p,visitor);
 if((await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM ${HANDOFFS} WHERE chat_id=$1 AND visitor=$2 AND created_at>clock_timestamp()-interval '1 hour' LIMIT $3) r`,[p.id,key,LIMITS.handoffsPerVisitor])).rows[0].n>=LIMITS.handoffsPerVisitor)throw new RateLimitError('Your questions were sent. Please wait for the team before sending more.');
 if((await c.query(`SELECT count(*)::int n FROM (SELECT 1 FROM ${HANDOFFS} WHERE workspace_id=$1 AND status='OPEN' LIMIT $2) r`,[p.workspace_id,LIMITS.openHandoffs])).rows[0].n>=LIMITS.openHandoffs)throw new RateLimitError('The team has many questions right now. Please contact the business directly.');
 await count(c,p,'handoffs');
 const f=await facts(c,ctx,p),matches=identify(f.products,question);
 const reason=askFirst?'The owner answers each website question personally (Ask me first).':PRIVATE.test(question)?'Asks about something the assistant does not share, such as costs, customers, orders or payments.':matches.length===1?'Stock for '+matches[0].code+' needs a person to confirm.':'Outside the published products and delivery policy.';
 const id=newId('website-handoff');
 await require('../commercial/storage-capacity').reserve(c,p.workspace_id,'website-handoff:'+id,4096,{finished:true});
 await c.query(`INSERT INTO ${HANDOFFS}(workspace_id,id,chat_id,question,reason,contact,visitor) VALUES($1,$2,$3,$4,$5,$6,$7)`,[p.workspace_id,id,p.id,question,reason,contact||null,key]);
 await audit(c,{workspaceId:p.workspace_id},{action:'Website question handed to a person',reference:id,after:{assistant:p.id,reason,contactLeft:Boolean(contact)}});
 return {id};
});}
async function closeHandoff(db,ctx,id){return tx(db,async c=>{await owner(c,ctx,true);const row=(await c.query(`UPDATE ${HANDOFFS} SET status='DONE',done_by=$3,done_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING id`,[ctx.workspaceId,id,ctx.actorId])).rows[0];if(!row)throw new NotFoundError('That website question is already done or not in this inventory.');await audit(c,ctx,{action:'Website question marked done',reference:id});return {id};});}
// Needs you: open website questions, for the owner.
async function inbox(db,workspaceId){
 if(!await require('../db/schema-installed').has(db,HANDOFFS))return [];
 const rows=(await db.query(`SELECT h.id,h.question,h.reason,h.contact,h.created_at,c.label FROM ${HANDOFFS} h JOIN stockchief_runtime.agent_website_stock_chats c ON c.id=h.chat_id
  WHERE h.workspace_id=$1 AND h.status='OPEN' ORDER BY h.created_at DESC,h.id LIMIT 20`,[workspaceId])).rows;
 return rows.map(r=>({kind:'sales',importance:'Needs You',priority:70,title:'Website question for the team',
  happened:'A visitor asked “'+(r.question.length>160?r.question.slice(0,157)+'…':r.question)+'” in '+r.label+'.',why:r.reason,
  recommendation:r.contact?'Reply to '+r.contact+', then mark it done.':'The visitor left no contact. Mark it done once read.',
  href:'/autopilot/website-stock-chat#handoffs',actionLabel:'Review question',sourceId:'website-handoff:'+r.id,createdAt:r.created_at,timeLabel:'Asked',at:r.created_at}));
}
async function screen(db,ctx,input={}){await owner(db,ctx);const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,84,'draft'),page=Number(input.page||1);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new ValidationError('Choose a valid assistant page.');const rows=(await db.query('SELECT p.*,l.name location_name FROM stockchief_runtime.agent_website_stock_chats p JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows,places=allowed?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY name,id LIMIT 251',[ctx.workspaceId])).rows:[];
 const extra=[...new Set(rows.flatMap(r=>placesOf(r)))],names=new Map(extra.length?(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,extra])).rows.map(l=>[l.id,l.name]):[]);
 for(const r of rows){r.location_ids=placesOf(r);r.location_names=r.location_ids.map(id=>names.get(id)||id);}
 const handoffs=await require('../db/schema-installed').has(db,HANDOFFS)?(await db.query(`SELECT h.*,c.label FROM ${HANDOFFS} h JOIN stockchief_runtime.agent_website_stock_chats c ON c.id=h.chat_id WHERE h.workspace_id=$1 ORDER BY h.status='OPEN' DESC,h.created_at DESC,h.id LIMIT 50`,[ctx.workspaceId])).rows:[];
 return {allowed,plan:state.plan,shadow:state.shadow,rows:rows.slice(0,100),more:rows.length>100,page,places:places.slice(0,250),morePlaces:places.length>250,handoffs,limits:LIMITS};}
async function readPage(db,ctx,{page=1}={}){const s=await screen(db,ctx,{page});return {summary:'Website visitors ask about an exact published product code’s current stock or your checked delivery policy. You choose the products, the locations that count and whether visitors see exact numbers or only in stock, low and out of stock. Costs, customers and orders are never shared; other questions go to your team. Pro and Custom need no training.',rows:s.rows.map(p=>({Assistant:p.label,Warehouse:p.location_names.join(', '),Products:p.sku_ids.length,Counts:p.show_quantity?'Published exact available quantities':p.low_stock_at?'In stock, low at '+p.low_stock_at+' or fewer, or out of stock':'Availability bands only',Status:p.enabled?'Published within current authority':'Stopped',link:'/autopilot/website-stock-chat'})).concat(s.handoffs.filter(h=>h.status==='OPEN').slice(0,20).map(h=>({Assistant:h.label,Question:h.question,Review:h.reason,Status:'Waiting for the team',link:'/autopilot/website-stock-chat#handoffs'}))),more:s.more};}
module.exports={publish,stop,profile,metadata,answer,handoff,closeHandoff,inbox,screen,origins,identify,action,LIMITS,PRIVATE,definition:{id:84,key:'website-stock-chat',label:'Review website stock and delivery answers',readPage}};
