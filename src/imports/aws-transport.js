'use strict';

const {createHash} = require('node:crypto');
const {S3Client, HeadObjectCommand, GetObjectCommand} = require('@aws-sdk/client-s3');
const {SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand} = require('@aws-sdk/client-sqs');
const {createPresignedPost} = require('@aws-sdk/s3-presigned-post');
const {configuration} = require('./aws-config');

function create({config = configuration(), s3, sqs, presign = createPresignedPost} = {}) {
  if (!config) throw new Error('AWS imports are not enabled.');
  s3 ||= new S3Client({region:config.region, maxAttempts:3});
  sqs ||= new SQSClient({region:config.region, maxAttempts:3});
  const checksum = row => Buffer.from(row.source_hash,'hex').toString('base64');
  const identity = row => ({Bucket:config.bucket, Key:row.object_key});
  return {
    async upload(row) {
      return presign(s3, {...identity(row), Expires:600,
        Fields:{'x-amz-checksum-algorithm':'SHA256', 'x-amz-checksum-sha256':checksum(row),
          'x-amz-meta-workspace':row.workspace_id, 'x-amz-meta-upload':row.id},
        Conditions:[['content-length-range',Number(row.source_bytes),Number(row.source_bytes)]],
      });
    },
    async inspect(row) {
      const head = await s3.send(new HeadObjectCommand({...identity(row), ChecksumMode:'ENABLED'}), {abortSignal:AbortSignal.timeout(15000)});
      if (Number(head.ContentLength)!==Number(row.source_bytes) || head.ChecksumSHA256!==checksum(row)
        || head.Metadata?.workspace!==row.workspace_id || head.Metadata?.upload!==row.id
        || !head.VersionId || head.VersionId==='null') {
        throw Object.assign(new Error('The uploaded file does not match its saved size, checksum or inventory. Upload the original again.'), {code:'upload_integrity',retryable:false});
      }
      return head.VersionId;
    },
    async read(row) {
      // Version pinning prevents a still-valid upload form overwriting the
      // approved original. Neither an SQS message nor a browser supplies keys.
      if (!row.version_id) throw new Error('The source object has no frozen version.');
      if(!Number.isSafeInteger(Number(row.source_bytes))||Number(row.source_bytes)<1||Number(row.source_bytes)>require('./source-formats').maxBytes)throw new Error('The saved source byte count exceeds the upload allowance.');
      const source = await s3.send(new GetObjectCommand({...identity(row), VersionId:row.version_id}), {abortSignal:AbortSignal.timeout(45000)});
      const chunks=[]; let length=0; const hash=createHash('sha256');
      try {
        for await (const chunk of source.Body) {
          length+=chunk.length;
          if (length>Number(row.source_bytes)) throw new Error('The saved file exceeded its approved byte count.');
          hash.update(chunk); chunks.push(chunk);
        }
      } catch(error) { source.Body?.destroy?.(); throw error; }
      if (length!==Number(row.source_bytes) || hash.digest('hex')!==row.source_hash) {
        throw Object.assign(new Error('The saved file failed its integrity check.'), {code:'upload_integrity',retryable:false});
      }
      return Buffer.concat(chunks,length);
    },
    async notify(id) {
      // This is a wake signal. The database remains the authority for tenant,
      // plan, approval, lease and idempotency; message bodies cannot grant it.
      await sqs.send(new SendMessageCommand({QueueUrl:config.queueUrl, MessageBody:JSON.stringify({v:1,id})}), {abortSignal:AbortSignal.timeout(5000)});
    },
    async receive(signal) {
      return (await sqs.send(new ReceiveMessageCommand({QueueUrl:config.queueUrl,WaitTimeSeconds:20,MaxNumberOfMessages:10,VisibilityTimeout:60}), {abortSignal:signal})).Messages || [];
    },
    async acknowledge(message) {
      await sqs.send(new DeleteMessageCommand({QueueUrl:config.queueUrl,ReceiptHandle:message.ReceiptHandle}));
    },
    destroy() {s3.destroy?.(); sqs.destroy?.();},
  };
}

let singleton;
function configured() {return singleton ||= create();}
module.exports = {create, configured};
