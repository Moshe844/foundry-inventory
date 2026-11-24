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
test('only the qualification bootstrap task can read the database owner secret',()=>{
 const worker=JSON.stringify(t.Resources.Task)+JSON.stringify(t.Resources.ExecutionRole);assert.doesNotMatch(worker,/MasterSecretArn/);
 for(const name of ['BootstrapTask','BootstrapExecutionRole'])assert.equal(t.Resources[name].Condition,'Qualification',name+' must not exist in production');
 const container=t.Resources.BootstrapTask.Properties.ContainerDefinitions[0],secrets=new Map(container.Secrets.map(s=>[s.Name,JSON.stringify(s.ValueFrom)]));
 assert.match(secrets.get('STOCKCHIEF_QUALIFICATION_MASTER_SECRET'),/MasterSecretArn/);assert.match(secrets.get('STOCKCHIEF_IMPORT_DATABASE_SECRET'),/QualificationSecretArn/);
 const env=new Map(container.Environment.map(v=>[v.Name,v.Value]));assert.equal(env.get('STOCKCHIEF_IMPORT_DATABASE_ROLE'),'stockchief_qualification');
 assert.match(JSON.stringify(env.get('STOCKCHIEF_IMPORT_DATABASE_NAME')),/QualificationDatabaseName/);assert.deepEqual(container.Command,['node','src/imports/aws-qualification-bootstrap.js']);
 assert.deepEqual(t.Resources.BootstrapTask.Properties.ExecutionRoleArn,{'Fn::GetAtt':['BootstrapExecutionRole','Arn']});
});
test('the worker image builds in CodeBuild from the private bucket and pushes only to this repository',()=>{
 const build=t.Resources.ImageBuild.Properties,policy=t.Resources.ImageBuildRole.Properties.Policies[0].PolicyDocument.Statement;
 assert.equal(build.Environment.PrivilegedMode,true);assert.match(build.Source.BuildSpec,/infra\/aws-imports\/Dockerfile/);assert.match(build.Source.BuildSpec,/public\.ecr\.aws\/docker\/library\/node:22\.23\.4-bookworm-slim/);
 assert.deepEqual(policy.find(s=>s.Action.includes?.('ecr:PutImage')).Resource,{'Fn::GetAtt':['Images','Arn']});
 assert.deepEqual(policy.find(s=>JSON.stringify(s.Action).includes('s3:GetObject')).Resource,{'Fn::Sub':'${Sources.Arn}/builds/*'});
});
