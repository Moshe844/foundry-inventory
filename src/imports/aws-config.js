'use strict';

function configuration(env = process.env) {
  if (env.STOCKCHIEF_IMPORT_BACKEND !== 'aws') return null;
  const region = env.AWS_REGION;
  const bucket = env.STOCKCHIEF_IMPORT_BUCKET;
  const queueUrl = env.STOCKCHIEF_IMPORT_QUEUE_URL;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region || '') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '')) {
    throw new Error('AWS imports require an explicit Region and private source bucket.');
  }
  const queue = new URL(queueUrl);
  if (queue.protocol !== 'https:' || queue.hostname !== `sqs.${region}.amazonaws.com` || !/^\/\d{12}\/[a-zA-Z0-9_-]+$/.test(queue.pathname) || queue.search || queue.username || queue.password) {
    throw new Error('The import queue must be an SQS queue in the selected Region.');
  }
  return Object.freeze({region, bucket, queueUrl, origin:`https://${bucket}.s3.${region}.amazonaws.com`});
}

module.exports = {configuration};
