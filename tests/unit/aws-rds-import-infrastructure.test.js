'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{template:t}=require('../../infra/aws-imports/build-rds-template');
test('colocated workers reuse the database network without a NAT or public inbound port',()=>{
 assert.equal(t.Parameters.WorkerCount.Default,0);assert.deepEqual(t.Parameters.WorkerCount.AllowedValues,[0,1,2]);
 assert.equal(Object.values(t.Resources).some(r=>['AWS::EC2::NatGateway','AWS::EC2::EIP','AWS::EC2::VPC','AWS::RDS::DBInstance'].includes(r.Type)),false);
 const network=t.Resources.Workers.Properties.NetworkConfiguration.AwsvpcConfiguration;
 assert.equal(network.AssignPublicIp,'ENABLED');assert.match(JSON.stringify(network.SecurityGroups),/ClientSecurityGroupId/);assert.match(JSON.stringify(network.Subnets),/SubnetIds/);
 assert.equal(t.Parameters.DatabaseIpv4Cidr,undefined);assert.equal(t.Outputs.DatabaseAllowlistIp,undefined);assert.equal(t.Resources.Workers.Properties.PlatformVersion,'1.4.0');
});
test('rehearsal defaults to separate synthetic credentials; the execution role can decrypt only the selected secret',()=>{
 assert.equal(t.Parameters.DeploymentPhase.Default,'qualification');
 const task=t.Resources.Task.Properties.ContainerDefinitions[0],secret=task.Secrets[0];assert.equal(secret.Name,'STOCKCHIEF_IMPORT_DATABASE_SECRET');
 assert.match(JSON.stringify(secret.ValueFrom),/QualificationSecretArn/);assert.doesNotMatch(JSON.stringify(secret.ValueFrom),/MasterSecretArn/);
 const env=new Map(task.Environment.map(v=>[v.Name,v.Value]));assert.match(JSON.stringify(env.get('STOCKCHIEF_IMPORT_DATABASE_NAME')),/QualificationDatabaseName/);
 assert.deepEqual(env.get('STOCKCHIEF_IMPORT_DATABASE_ROLE'),{'Fn::If':['Qualification','stockchief_qualification','stockchief_runtime']});
 for(const name of ['ExecutionRole','ImportRole']){
  const condition=t.Resources[name].Properties.AssumeRolePolicyDocument.Statement[0].Condition;
  assert.deepEqual(condition.StringEquals['aws:SourceAccount'],{Ref:'AWS::AccountId'});assert.ok(condition.ArnLike['aws:SourceArn']);
 }
 const policy=t.Resources.ExecutionRole.Properties.Policies[0].PolicyDocument.Statement;
 assert.deepEqual(policy[0].Resource,secret.ValueFrom);assert.equal(policy[1].Action,'kms:Decrypt');assert.match(JSON.stringify(policy[1].Resource),/DataKeyArn/);
 assert.deepEqual(policy[1].Condition.StringEquals['kms:EncryptionContext:SecretARN'],secret.ValueFrom);
 assert.equal(t.Resources.Alerts.Properties.Subscription,undefined,'Do not infer or message a recipient.');
 assert.equal(t.Parameters.MonthlyBudget.Default,10,'This is a console budget, not a hard billing cap.');
});
