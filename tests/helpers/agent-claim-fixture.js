'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,plan='pro'){
 const f=await require('./agent-quality-fixture').fixture(t,plan),{db,ctx,quality}=f;
 await db.query("UPDATE suppliers SET email='damage@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const connectorId=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Claim mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'claims@example.test',now(),now())`,[connectorId,ctx.workspaceId,'connection_credentials:'+connectorId,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connectorId,'provider',{accessToken:'synthetic-claim-token'}));
 await quality.save(db,ctx,f.scope);
 async function damaged(count=2){const receipt=await f.receive(await f.order(),{qcConfirmed:'yes'}),id=receipt.qualityHoldIds[0];await quality.inspect(db,ctx,id,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Two packages have visible tears, physically counted.',...(count===null?{}:{damagedQuantity:count})});return id;}
 const service=require('../../src/purchasing/agent-supplier-claims'),photoService=require('../../src/operations/quality-photos'),sent=[];
 const bytes=await require('sharp')({create:{width:2300,height:1700,channels:3,background:'#8a5c34'}}).png().toBuffer();
 const photo=(holdId,extra={})=>photoService.upload(db,ctx,holdId,{filename:'physical-test.png',buffer:bytes},{caption:'Synthetic transport test image',...extra});
 const preview=(holdId,photoIds=[])=>service.preview(db,ctx,{holdId,connectorId,photoIds});
 const send=r=>service.send(db,ctx,r.id,{confirmed:'yes',sourceFingerprint:r.source_fingerprint});
 const limits=(extra={})=>({confirmed:'yes',maxUnits:2,maxValue:'2.00',maxWeekly:'6.00',maxAgeDays:30,includePhotos:'yes',...extra});
 const provider={send:async({message})=>{sent.push(message);return {externalMessageId:'claim-accepted-'+message.id};}};
 async function deliver(){const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider}),kind='agent.mail.supplier_claim.v1',results=[];for(let i=0;i<20;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'qualified-claim-worker'});if(!r)break;results.push(r);if(r.status!=='COMPLETED')throw Error(JSON.stringify(r.lastError));}return results;}
 return {...f,connectorId,service,photoService,bytes,damaged,photo,preview,send,limits,provider,sent,deliver};
}
module.exports={fixture};
