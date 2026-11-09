'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('spec and safety facts retain exact source quotes, plan ceilings and immutable existing evidence',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const now=new Date().toISOString(),connection=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
  VALUES('spec-mailbox',$1,'spec-mailbox','Spec mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$2,$3,$3) RETURNING *`,[ctx.workspaceId,ctx.actorId,now])).rows[0];
 await db.query("UPDATE suppliers SET email='specs@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,sourceText='SAFETY SHEET\nProduct '+code+'\nManufacturer: Acme Tooling\nStorage: Keep dry.\nHandling: Wear nitrile gloves.\nTemperature range: 5 C to 30 C\nCountry of origin: USA\nRevision: 2026-11\nCertification: ISO 9001\nAluminium housing';
 const mail=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'specs@example.test',subject:'Safety sheet',bodyText:'Original supplier sheet attached.',attachments:[{filename:'Safety sheet.txt',contentBase64:Buffer.from(sourceText).toString('base64')}]});
 await require('../../src/connections/postgres-attachments').extractMessage(db,ctx.workspaceId,mail.messageId);
 const attachment=(await db.query('SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,mail.messageId])).rows[0];
 const assistant=require('../../src/assistant/postgres-service'),file=await assistant.prepareAction(db,ctx,'File the product safety sheet',{action:'document.file_to_item',recordReference:'Parcel item',fileAttachment:attachment.id,documentKind:'safety_sheet'});
 const documentId=(await assistant.executeProposal(db,ctx,file.proposal.id)).result.documentId;
 const fact=(field,value,quote)=>({field,value,quote}),storage=fact('storage','Keep dry.','Storage: Keep dry.'),manufacturer=fact('manufacturer','Acme Tooling','Manufacturer: Acme Tooling'),handling=fact('handling','Wear nitrile gloves.','Handling: Wear nitrile gloves.'),temperature=fact('temperature','5 C to 30 C','Temperature range: 5 C to 30 C');
 const request=rows=>({action:'document.save_product_facts',recordReference:'Parcel item',filedDocument:documentId,documentFacts:JSON.stringify(rows)}),prepare=rows=>assistant.prepareAction(db,ctx,'Save quoted product facts',request(rows));
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(tier==='starter'){await assert.rejects(prepare([storage]),e=>e.code==='entitlement_required');await browser.get('/autopilot/reviews/product-document-facts').expect(402);}else{assert.equal((await prepare([storage])).status,'PREPARED');await browser.get('/autopilot/reviews/product-document-facts').expect(200);}
 }
 const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 async function mission(p){await plans.save(db,ctx,'Save the sourced facts then inspect them',randomUUID(),[{contract:registry.get('document.save_product_facts'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'product-document-facts'},dependsOn:[0]}],[{result:p},{result:{status:'CLARIFY'}}]);return assistant.executeMission(db,ctx,p.proposal.id);}
 await subscribe('growth');const reviewed=await prepare([storage]);await assert.rejects(mission(reviewed),e=>e.code==='entitlement_required');
 const page=await browser.get('/actions/'+reviewed.proposal.id).expect(200);assert.match(page.text,/Source quote/);assert.match(page.text,/Storage: Keep dry/);assert(!page.text.includes('<dt>Expected facts hash</dt>'));
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,reviewed.proposal.id),e=>e.code==='entitlement_required');
 await subscribe('growth');const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,136,{mode:'watch',revision:0});await assert.rejects(assistant.executeProposal(db,ctx,reviewed.proposal.id),/Watch only/);await modes.save(db,ctx,136,{mode:'inherit',revision:1});
 await assistant.executeProposal(db,ctx,reviewed.proposal.id);await assistant.executeProposal(db,ctx,reviewed.proposal.id);
 const stored=async()=>(await db.query('SELECT product_facts,facts_revision FROM stockchief_runtime.agent_filed_documents WHERE id=$1',[documentId])).rows[0];assert.deepEqual((await stored()).product_facts,[storage]);
 await subscribe('pro');const automatic=await prepare([manufacturer,handling]);await mission(automatic);assert.equal((await stored()).product_facts.length,3);
 await subscribe('enterprise');await mission(await prepare([temperature]));assert.equal((await stored()).product_facts.length,4);
 const ambiguous=await prepare([fact('composition','Aluminium housing','Aluminium housing')]);assert.match(ambiguous.proposal.summary,/Confirm the field interpretation/);await assert.rejects(mission(ambiguous),/own confirmation/);await assistant.executeProposal(db,ctx,ambiguous.proposal.id);
 await assert.rejects(prepare([fact('hazards','Explosive','Hazards: Explosive')]),/copied exactly/);
 await assert.rejects(prepare([fact('purchase_cost','$95.00','$95.00')]),/supported product-fact/);
 await assert.rejects(prepare([fact('manufacturer','Tooling','Manufacturer: Acme Tooling')]),/already saved differently/);
 const before=await stored(),origin=fact('origin','USA','Country of origin: USA'),revision=fact('revision','2026-11','Revision: 2026-11'),a=await prepare([origin]),b=await prepare([revision]);
 await assistant.executeProposal(db,ctx,a.proposal.id);await assert.rejects(assistant.executeProposal(db,ctx,b.proposal.id),/facts changed/);assert.equal((await stored()).facts_revision,before.facts_revision+1);
 await assistant.executeProposal(db,ctx,(await prepare([revision])).proposal.id);
 const same=await prepare([storage]);const version=(await stored()).facts_revision;assert.equal((await assistant.executeProposal(db,ctx,same.proposal.id)).result.replayed,true);assert.equal((await stored()).facts_revision,version);
 const certification=await prepare([fact('certifications','ISO 9001','Certification: ISO 9001')]),override=randomUUID();
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'storage_bytes',0,'Check fact storage limits')",[override,f.owner.accountId]);
 await assert.rejects(assistant.executeProposal(db,ctx,certification.proposal.id),e=>e.code==='entitlement_required');assert.equal((await stored()).facts_revision,version);await db.query('DELETE FROM commercial_entitlement_overrides WHERE id=$1',[override]);await assistant.executeProposal(db,ctx,certification.proposal.id);
 const saved=await browser.get('/autopilot/documents/'+documentId).expect(200);assert.match(saved.text,/Saved product facts/);assert.match(saved.text,/Acme Tooling/);assert.match(saved.text,/Country of origin/);
 assert.equal((await require('../../src/autopilot/job-reviews').run(db,ctx,'product-document-facts')).rows.length,8);
 assert.equal((await require('../../src/autopilot/job-reviews').run(db,ctx,'product-document-facts',{filter:code})).rows.length,8);
 assert.match((await browser.get('/autopilot/documents').query({kind:'item',record:f.item.itemId}).expect(200)).text,/8 saved product facts/);
 assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].total_cost_minor,'400');
 await subscribe('starter');assert.match((await browser.get('/autopilot/documents/'+documentId).expect(200)).text,/Saved product facts/);
 await assert.rejects(require('../../src/documents/agent-filing').load(db,{...ctx,actorId:'another-user'},documentId),/owner/);
 await subscribe('pro');const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Other product',baseCode:'SPEC-OTHER',trackingMode:'quantity'});
 await assert.rejects(assistant.prepareAction(db,ctx,'Use the wrong product source',{...request([storage]),recordReference:'Other product'}),/exact product/);
 const pdf=new (require('pdfkit'))({compress:false}),chunks=[];pdf.on('data',b=>chunks.push(b));const ended=new Promise(resolve=>pdf.on('end',resolve));pdf.text('SPECIFICATION\nProduct '+code+'\nModel: AT-500');pdf.end();await ended;
 const pdfMessage=await require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender:'specs@example.test',subject:'Product spec',bodyText:'Original PDF attached.',attachments:[{filename:'Product spec.pdf',contentBase64:Buffer.concat(chunks).toString('base64')}]});
 await require('../../src/connections/postgres-attachments').extractMessage(db,ctx.workspaceId,pdfMessage.messageId);
 const pdfAttachment=(await db.query('SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,pdfMessage.messageId])).rows[0];
 const pdfApproval=await assistant.prepareAction(db,ctx,'File the actual PDF spec',{action:'document.file_to_item',recordReference:'Parcel item',fileAttachment:pdfAttachment.id,documentKind:'specification'}),pdfId=(await assistant.executeProposal(db,ctx,pdfApproval.proposal.id)).result.documentId;
 const loaded=await require('../../src/documents/agent-filing').load(db,ctx,pdfId),quote=/Model:\s*AT-500/.exec(loaded.extracted_text)?.[0];assert(quote,loaded.extracted_text);
 const extracted=await assistant.prepareAction(db,ctx,'Save the model from the PDF',{...request([fact('model','AT-500',quote)]),filedDocument:pdfId});await mission(extracted);
 assert.equal((await require('../../src/documents/agent-filing').load(db,ctx,pdfId)).product_facts[0].value,'AT-500');
 assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND target_id=$2',[ctx.workspaceId,other.itemId])).rows[0].n,0);
});
