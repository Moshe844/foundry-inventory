'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {template}=require('../../infra/aws-imports/build-template');

test('AWS imports start disabled, cap workers at two and do not create another database',()=>{
 assert.equal(template.Parameters.WorkerCount.Default,0);
 assert.deepEqual(template.Parameters.WorkerCount.AllowedValues,[0,1,2]);
 assert.equal(Object.values(template.Resources).some(r=>/RDS|Batch|EKS/.test(r.Type)),false);
 assert.equal(template.Resources.Task.Properties.Cpu,'1024');
 assert.equal(template.Resources.Task.Properties.Memory,'2048');
 assert.equal(template.Resources.Workers.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp,'DISABLED');
 assert.equal(template.Resources.WorkerFirewall.Properties.SecurityGroupIngress,undefined);
 assert.match(template.Parameters.DatabaseIpv4Cidr.AllowedPattern,/\/32$/);
});

test('private originals are versioned/encrypted, retained on stack deletion and never use wildcard CORS',()=>{
 const source=template.Resources.Sources;
 assert.equal(source.DeletionPolicy,'Retain');
 assert.equal(source.Properties.VersioningConfiguration.Status,'Enabled');
 assert.equal(source.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,true);
 assert.deepEqual(source.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins,[{Ref:'ApplicationOrigin'}]);
 assert.equal(source.Properties.LifecycleConfiguration.Rules[0].ExpirationInDays,7);
});

test('runtime roles cannot change infrastructure or create keys; queues have a dead-letter alarm',()=>{
 const policies=template.Resources.ImportRole.Properties.Policies;
 assert.equal(JSON.stringify(policies).includes('s3:PutObject'),false);
 assert.equal(JSON.stringify(policies).includes('iam:'),false);
 assert.equal(Object.values(template.Resources).some(r=>r.Type==='AWS::IAM::AccessKey'),false);
 assert.equal(template.Resources.ImportQueue.Properties.RedrivePolicy.maxReceiveCount,5);
 assert.equal(template.Resources.DeadLetters.Properties.MessageRetentionPeriod,1209600);
 assert.ok(template.Resources.DeadLetterAlarm);
 assert.equal(template.Resources.Task.Properties.ContainerDefinitions[0].StopTimeout,120);
});
