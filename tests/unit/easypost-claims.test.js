'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const claims=require('../../src/shipping/easypost-claims');

const ctx={easypostApiKey:'EZTK_synthetic'};
const claim={insuranceId:'ins_fixture',externalId:'shp_fixture',trackingNumber:'TRACK1',
  reference:'stockchief-claim_one',type:'damage',amountMinor:2505,description:'The carton arrived crushed.',
  recipient:'Example business',contactEmail:'owner@example.com',invoice:Buffer.from('invoice'),
  emailEvidence:Buffer.from('email'),supporting:Buffer.from('photo')};
const proof={id:'ins_fixture',object:'Insurance',mode:'test',tracking_code:'TRACK1',shipment_id:'shp_fixture',
  status:'purchased',amount:'25.05999'};
const confirmation={id:'clm_fixture',object:'Claim',mode:'test',reference:claim.reference,insurance_id:claim.insuranceId,
  shipment_id:claim.externalId,tracking_code:claim.trackingNumber,type:'damage',status:'submitted',requested_amount:'25.05'};

test('insurance matches the account mode, exact parcel, paid coverage and whole cents',async()=>{
  const request=async(account,path)=>{
    assert.equal(account,ctx);
    assert.equal(path,'/insurances/ins_fixture');
    return proof;
  };
  assert.deepEqual(await claims.coverage(ctx,claim,request),{insuranceId:claim.insuranceId,trackingNumber:claim.trackingNumber,
    externalId:claim.externalId,mode:'test',limitMinor:2505});
  for(const change of [{shipment_id:'shp_other'},{tracking_code:'OTHER'},{status:'cancelled'},{mode:'production'},{amount:'-3'}]){
    await assert.rejects(claims.coverage(ctx,claim,async()=>({...proof,...change})),/confirm active insurance|valid insurance amount/);
  }
  await assert.rejects(claims.coverage({},claim,()=>assert.fail('Unscoped provider request')),/shipping account/);
  await assert.rejects(claims.coverage(ctx,{...claim,insuranceId:'../claims'},()=>assert.fail('Untrusted path')),/insurance number/);
});

test('a damage claim sends the original evidence and approved amount in one provider request',async()=>{
  let writes=0;
  const result=await claims.submit(ctx,claim,async(account,path,options)=>{
    assert.equal(account,ctx);
    assert.equal(path,'/claims');
    assert.equal(options.method,'POST');
    assert.equal(options.retries,0);
    assert.deepEqual(options.body,{type:'damage',reference:claim.reference,tracking_code:'TRACK1',amount:'25.05',
      description:claim.description,recipient_name:claim.recipient,contact_email:claim.contactEmail,
      invoice_attachments:[claim.invoice.toString('base64')],email_evidence_attachments:[claim.emailEvidence.toString('base64')],
      supporting_documentation_attachments:[claim.supporting.toString('base64')]});
    writes++;
    return confirmation;
  });
  assert.equal(writes,1);
  assert.deepEqual(result,{id:'clm_fixture',reference:claim.reference,status:'submitted',amountMinor:2505,approvedMinor:null,detail:null});
  await assert.rejects(claims.submit(ctx,{...claim,supporting:null},()=>assert.fail('Missing damage evidence')),/required evidence/);
});

test('unexpected provider receipts are held and recovery only reads the original reference',async()=>{
  for(const change of [{insurance_id:'ins_other'},{requested_amount:'25.04'},{mode:'production'},
    {reference:'stockchief-other'},{status:'unknown'},{shipment_id:'shp_other'}]){
    await assert.rejects(claims.submit(ctx,claim,async()=>({...confirmation,...change})),e=>e.providerOutcomeUncertain===true);
  }
  const held=await claims.retrieve(ctx,claim,async(account,path,options)=>{
    assert.equal(account,ctx);
    assert.equal(path,'/claims/'+claim.reference);
    assert.equal(options,undefined);
    return {...confirmation,status:'needs_action',status_detail:'Add a photo of the outer box.'};
  });
  assert.equal(held.status,'needs_action');
  assert.equal(held.detail,'Add a photo of the outer box.');
});
