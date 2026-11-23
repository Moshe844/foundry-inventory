'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {Readable}=require('node:stream');
const {configuration}=require('../../src/imports/aws-config');
const {create}=require('../../src/imports/aws-transport');
const worker=require('../../src/imports/aws-worker');
const env={STOCKCHIEF_IMPORT_BACKEND:'aws',AWS_REGION:'us-east-2',STOCKCHIEF_IMPORT_BUCKET:'stockchief-import-test',STOCKCHIEF_IMPORT_QUEUE_URL:'https://sqs.us-east-2.amazonaws.com/123456789012/stockchief-imports'};
const config=configuration(env),bytes=Buffer.from('SKU,Quantity\nCOFFEE,3.75\n');
const row={id:'upl_test',workspace_id:'wsp_test',object_key:'sources/wsp_test/upl_test/original',version_id:'immutable-version',source_bytes:bytes.length,source_hash:createHash('sha256').update(bytes).digest('hex')};

test('AWS import transport is opt-in and rejects a cross-Region queue',()=>{
 assert.equal(configuration({}),null);
 assert.throws(()=>configuration({...env,STOCKCHIEF_IMPORT_QUEUE_URL:'https://sqs.us-east-1.amazonaws.com/123456789012/test'}),/selected Region/);
 assert.throws(()=>configuration({...env,STOCKCHIEF_IMPORT_BUCKET:'bucket; connect-src *'}),/private source bucket/);
});

test('signed upload policy binds inventory, SHA-256, object key, exact length and expiry',async()=>{
 let request;
 const transport=create({config,s3:{},sqs:{},presign:async(_s3,input)=>{request=input;return {url:'signed',fields:{}};}});
 await transport.upload(row);
 assert.equal(request.Key,row.object_key);assert.equal(request.Expires,600);
 assert.equal(request.Fields['x-amz-meta-workspace'],row.workspace_id);
 assert.equal(request.Fields['x-amz-checksum-sha256'],Buffer.from(row.source_hash,'hex').toString('base64'));
 assert.deepEqual(request.Conditions,[['content-length-range',bytes.length,bytes.length]]);
});

test('the official SDK signs exact inventory/checksum/key conditions without network access',async()=>{
 const {S3Client}=require('@aws-sdk/client-s3');
 const s3=new S3Client({region:'us-east-2',credentials:{accessKeyId:'TESTONLYACCESSKEY',secretAccessKey:'test-only-not-a-real-credential'}});
 const transport=create({config,s3,sqs:{}});
 try{
  const signed=await transport.upload(row),policy=JSON.parse(Buffer.from(signed.fields.Policy,'base64').toString('utf8'));
  for(const field of ['x-amz-meta-workspace','x-amz-meta-upload','x-amz-checksum-sha256'])assert.ok(policy.conditions.some(c=>c[field]===signed.fields[field]));
  assert.ok(policy.conditions.some(c=>c.key===row.object_key));
  assert.ok(policy.conditions.some(c=>Array.isArray(c)&&c[0]==='content-length-range'&&c[1]===bytes.length&&c[2]===bytes.length));
 }finally{s3.destroy();}
});

test('a failed or malformed wake cannot perform work; receiver shutdown aborts its long poll',async()=>{
 let wakes=0,acknowledged=0,calls=0;const errors=[];
 const transport={async receive(signal){
  if(calls++===0)return [{Body:'not json',ReceiptHandle:'bad'},{Body:JSON.stringify({v:1,id:'rjob_valid'}),ReceiptHandle:'good'}];
  return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));
 },async acknowledge(){acknowledged++;}};
 const receiver=worker.listen(transport,{wake(){wakes++;}},{onError:error=>errors.push(error.code)});
 await new Promise(resolve=>setImmediate(resolve));await receiver.stop();
 assert.equal(wakes,1);assert.equal(acknowledged,1);assert.deepEqual(errors,['import_wake_invalid']);
});

test('completion rejects substituted metadata, missing version and wrong size/checksum',async()=>{
 const head={ContentLength:bytes.length,ChecksumSHA256:Buffer.from(row.source_hash,'hex').toString('base64'),Metadata:{workspace:row.workspace_id,upload:row.id},VersionId:row.version_id};
 const inspect=async response=>create({config,s3:{send:async()=>response},sqs:{}}).inspect(row);
 assert.equal(await inspect(head),row.version_id);
 for(const change of [{ContentLength:1},{ChecksumSHA256:'wrong'},{VersionId:'null'},{Metadata:{workspace:'wsp_other',upload:row.id}}])await assert.rejects(inspect({...head,...change}),/does not match/);
});

test('reading pins the frozen version and rechecks bytes; corrupted or oversized sources fail',async()=>{
 let input;
 const read=chunks=>create({config,sqs:{},s3:{send:async command=>{input=command.input;return {Body:Readable.from(chunks)};}}}).read(row);
 assert.deepEqual(await read([bytes.subarray(0,8),bytes.subarray(8)]),bytes);
 assert.equal(input.VersionId,row.version_id);
 await assert.rejects(read([Buffer.from('x'.repeat(bytes.length))]),/integrity/);
 await assert.rejects(read([bytes,Buffer.from('extra')]),/byte count/);
});

test('only import handlers run on AWS; queue messages carry no execution authority',()=>{
 const original=Object.assign(async()=>({ok:true}),{externalEffect:true,workerLane:'bulk'});
 const handlers=worker.dedicatedHandlers({'import.analyse-source':original,'import.execute-approved':original,'assistant.run-goal':()=>{throw Error('no');}});
 assert.deepEqual(Object.keys(handlers),worker.KINDS);
 assert.equal(handlers['import.analyse-source.aws'].externalEffect,true);
 assert.equal(handlers['import.execute-approved'].workerLane,'imports');
 assert.equal(original.workerLane,'bulk','Do not mutate Render handler metadata');
 assert.equal(worker.validWake({Body:JSON.stringify({v:1,id:'rjob_abc'})}),true);
 assert.equal(worker.validWake({Body:JSON.stringify({workspace:'other',plan:'unapproved'})}),false);
 assert.throws(()=>worker.databaseAddress('postgres://user:secret@database/db?sslmode=verify-full'),/private hostnames/);
 assert.throws(()=>worker.databaseAddress('postgres://user:secret@db.example.test/db?sslmode=require'),/verify-full/);
});
