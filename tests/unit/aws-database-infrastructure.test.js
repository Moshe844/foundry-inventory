'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{template:t}=require('../../infra/aws-database/build-template');

test('database migration target retains encrypted data, managed credentials and same-major compatibility',()=>{
 const db=t.Resources.Database;
 assert.equal(db.Properties.Engine,'postgres');assert.equal(t.Parameters.EngineVersion.Default,'17.11');assert.equal(db.Properties.AllowMajorVersionUpgrade,false);
 assert.equal(db.Properties.StorageEncrypted,true);assert.equal(db.Properties.ManageMasterUserPassword,true);assert.equal(db.Properties.MasterUserPassword,undefined);
 assert.equal(db.Properties.BackupRetentionPeriod,7);assert.equal(db.Properties.DeletionProtection,true);
 assert.equal(db.DeletionPolicy,'Retain');assert.equal(db.UpdateReplacePolicy,'Retain');
 assert.deepEqual(db.Properties.MultiAZ,{'Fn::If':['Production',true,false]});
 assert.equal(t.Resources.Parameters.Properties.Parameters['rds.force_ssl'],'1');
 assert.ok(t.Resources.DatabaseLogs.Properties.KmsKeyId);assert.equal(t.Resources.DataKey.Properties.EnableKeyRotation,true);
});
test('database starts private and cannot open PostgreSQL to the internet',()=>{
 assert.equal(t.Parameters.AllowRestrictedRenderAccess.Default,'false');
 assert.deepEqual(t.Resources.Database.Properties.PubliclyAccessible,{'Fn::If':['RestrictedRenderAccess',true,false]});
 assert.deepEqual(t.Resources.DatabaseFirewall.Properties.SecurityGroupIngress,[{IpProtocol:'tcp',FromPort:5432,ToPort:5432,SourceSecurityGroupId:{Ref:'ClientFirewall'}}]);
 for(let i=1;i<=8;i++){
  const pattern=new RegExp(t.Parameters['RenderCidr'+i].AllowedPattern);assert(!pattern.test('0.0.0.0/0'));assert(!pattern.test('::/0'));assert(pattern.test('203.0.113.0/24'));
  assert.equal(t.Resources['RenderIngress'+i].Condition,'RenderRange'+i);
 }
 assert.ok(t.Rules.RenderException);assert.equal(t.Resources.ClientFirewall.Properties.SecurityGroupIngress,undefined);
 assert.equal(Object.values(t.Resources).some(r=>r.Type==='AWS::EC2::NatGateway'),false);
 assert.equal(t.Resources.DatabaseSubnets.Properties.SubnetIds.length,2);
});
test('bounded hardware and storage remain distinct from customer entitlements and retained backup evidence',()=>{
 assert.equal(t.Parameters.DatabaseClass.Default,'db.m7g.large');assert.deepEqual(t.Parameters.DatabaseClass.AllowedValues,['db.m7g.large','db.m7g.xlarge']);
 assert.equal(t.Parameters.AllocatedStorage.Default,50);assert.equal(t.Parameters.MaxAllocatedStorage.Default,100);
 const evidence=t.Resources.MigrationEvidence;
 assert.equal(evidence.DeletionPolicy,'Retain');assert.equal(evidence.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,true);
 assert.equal(evidence.Properties.VersioningConfiguration.Status,'Enabled');assert.equal(evidence.Properties.LifecycleConfiguration.Rules.some(r=>r.ExpirationInDays),false);
 assert.equal(t.Metadata.AWSToolsMetrics.AWSAgentToolkit,'aws-cloudformation@3');
 assert.equal(Object.values(t.Resources).some(r=>r.Type==='AWS::IAM::AccessKey'),false);
 assert.equal(JSON.stringify(t.Outputs).includes('password'),false);
});
