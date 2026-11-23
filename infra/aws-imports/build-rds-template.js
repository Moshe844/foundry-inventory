'use strict';
const fs=require('node:fs'),path=require('node:path');
// Preserve the separately reviewed external-Render/NAT design as an option;
// the migration uses this colocated design and incurs no NAT gateway charge.
const template=structuredClone(require('./build-template').template),r=template.Resources;
const ref=name=>({Ref:name}),sub=value=>({'Fn::Sub':value}),get=(name,attribute)=>({'Fn::GetAtt':[name,attribute]});
const imported=name=>({'Fn::ImportValue':sub('${DatabaseStackName}:'+name)}),choose=(a,b)=>({'Fn::If':['Qualification',a,b]});
for(const name of ['Network','Gateway','GatewayAttachment','PublicSubnet','WorkerSubnet','PublicRoutes','PublicRouteAssociation','InternetRoute','FixedEgress','Nat','WorkerRoutes','WorkerRouteAssociation','WorkerInternetRoute','S3Endpoint','WorkerFirewall'])delete r[name];
delete template.Parameters.DatabaseSecretArn;delete template.Parameters.DatabaseIpv4Cidr;delete template.Parameters.AlertEmail;
template.Parameters.DatabaseStackName={Type:'String',AllowedPattern:'[a-zA-Z][a-zA-Z0-9-]{0,127}',Description:'Reviewed database stack in this project/Region; imports its scoped secret and private client network.'};
template.Parameters.DeploymentPhase={Type:'String',Default:'qualification',AllowedValues:['qualification','production'],Description:'Qualification connects only to the separate synthetic database. Production requires passed qualification and cutover approval.'};
template.Parameters.WorkerCount.Description='Zero until bootstrap, credentials, isolated qualification and network checks are ready; at most two tasks.';
template.Parameters.MonthlyBudget.Default=10;
template.Conditions={Qualification:{'Fn::Equals':[ref('DeploymentPhase'),'qualification']}};
template.Description='StockChief imports colocated with the AWS database: private database traffic, bounded Fargate tasks and no NAT gateway. Qualification uses a separate synthetic database.';
template.Metadata={AWSToolsMetrics:{AWSAgentToolkit:'aws-cloudformation@3'},'com.aws.cloudformation.Context':{ref:['../aws-database/README.md'],must:['Do not run restored customer jobs during qualification.','No paid creation or live cutover without the applicable approval.']}};
const secret=choose(imported('QualificationSecretArn'),imported('ApplicationSecretArn'));
for(const role of ['ExecutionRole','ImportRole'])r[role].Properties.AssumeRolePolicyDocument.Statement[0].Condition={StringEquals:{'aws:SourceAccount':ref('AWS::AccountId')},ArnLike:{'aws:SourceArn':sub('arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:*')}};
r.ExecutionRole.Properties.Policies=[{PolicyName:'OnlySelectedDatabaseSecret',PolicyDocument:{Version:'2012-10-17',Statement:[
 {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:secret},
 {Effect:'Allow',Action:'kms:Decrypt',Resource:imported('DataKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com'),'kms:EncryptionContext:SecretARN':secret}}},
]}}];
const container=r.Task.Properties.ContainerDefinitions[0];
container.Secrets=[{Name:'STOCKCHIEF_IMPORT_DATABASE_SECRET',ValueFrom:secret}];
container.Environment.push({Name:'STOCKCHIEF_IMPORT_DATABASE_NAME',Value:choose(imported('QualificationDatabaseName'),imported('DatabaseName'))},{Name:'STOCKCHIEF_IMPORT_DATABASE_ROLE',Value:choose('stockchief_qualification','stockchief_runtime')},{Name:'STOCKCHIEF_IMPORT_DATABASE_HOST',Value:imported('Host')},{Name:'FOUNDRY_IMPORT_STOCK_WORKERS',Value:'4'});
r.Workers.Properties.PlatformVersion='1.4.0';
r.Workers.Properties.NetworkConfiguration.AwsvpcConfiguration={AssignPublicIp:'ENABLED',Subnets:{'Fn::Split':[',',imported('SubnetIds')]},SecurityGroups:[imported('ClientSecurityGroupId')]};
delete r.Workers.DependsOn;
delete r.Alerts.Properties.Subscription;
// The owner can subscribe to the alarm topic after choosing a recipient. Do
// not infer a third party's email from a connected service or send messages.
delete r.Budget.Properties.NotificationsWithSubscribers;
delete template.Outputs.DatabaseAllowlistIp;
template.Outputs.DatabaseStack={Value:ref('DatabaseStackName')};
if(require.main===module)fs.writeFileSync(path.join(__dirname,'template-rds.json'),JSON.stringify(template,null,2)+'\n');
module.exports={template};
