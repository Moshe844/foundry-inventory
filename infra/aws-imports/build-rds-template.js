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
// Qualification only: a one-off task that creates the separate synthetic
// database and its scoped role (src/imports/aws-qualification-bootstrap.js).
// It alone reads the database owner secret; the import workers never do, and
// it does not exist in a production deployment.
const master=imported('MasterSecretArn'),qualificationSecret=imported('QualificationSecretArn');
r.BootstrapExecutionRole={Type:'AWS::IAM::Role',Condition:'Qualification',Properties:{
 AssumeRolePolicyDocument:structuredClone(r.ExecutionRole.Properties.AssumeRolePolicyDocument),
 ManagedPolicyArns:structuredClone(r.ExecutionRole.Properties.ManagedPolicyArns),
 Policies:[{PolicyName:'OwnerAndQualificationSecrets',PolicyDocument:{Version:'2012-10-17',Statement:[
  {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:[master,qualificationSecret]},
  {Effect:'Allow',Action:'kms:Decrypt',Resource:imported('DataKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com')},'ForAnyValue:StringEquals':{'kms:EncryptionContext:SecretARN':[master,qualificationSecret]}}},
 ]}}]}};
const bootstrapContainer=structuredClone(container);
bootstrapContainer.Name='qualification-bootstrap';
bootstrapContainer.Command=['node','src/imports/aws-qualification-bootstrap.js'];
bootstrapContainer.Secrets=[{Name:'STOCKCHIEF_IMPORT_DATABASE_SECRET',ValueFrom:qualificationSecret},{Name:'STOCKCHIEF_QUALIFICATION_MASTER_SECRET',ValueFrom:master}];
bootstrapContainer.Environment=[...bootstrapContainer.Environment.filter(v=>!['STOCKCHIEF_IMPORT_DATABASE_NAME','STOCKCHIEF_IMPORT_DATABASE_ROLE'].includes(v.Name)),
 {Name:'STOCKCHIEF_IMPORT_DATABASE_NAME',Value:imported('QualificationDatabaseName')},{Name:'STOCKCHIEF_IMPORT_DATABASE_ROLE',Value:'stockchief_qualification'},
 {Name:'STOCKCHIEF_MIGRATION_DATABASE_NAME',Value:imported('DatabaseName')}];
bootstrapContainer.LogConfiguration=structuredClone(container.LogConfiguration);bootstrapContainer.LogConfiguration.Options['awslogs-stream-prefix']='qualification-bootstrap';
r.BootstrapTask={Type:'AWS::ECS::TaskDefinition',Condition:'Qualification',Properties:{...structuredClone(r.Task.Properties),
 Family:'stockchief-imports-qualification-bootstrap',ExecutionRoleArn:get('BootstrapExecutionRole','Arn'),TaskRoleArn:get('ImportRole','Arn'),ContainerDefinitions:[bootstrapContainer]}};
// The move from Render: a one-off task that restores Render's export from the
// migration bucket's exports/ folder into the database customers will use, as an
// unswitched copy (src/db/aws-restore.js). It reads the master, owner and website
// login secrets; the import workers never get the master or owner secret. Never run
// it after the switch except to inspect: a database marked live is never replaced.
const ownerSecret=imported('OwnerSecretArn'),applicationSecret=imported('ApplicationSecretArn'),restoreSecrets=[master,ownerSecret,applicationSecret];
r.RestoreExecutionRole={Type:'AWS::IAM::Role',Properties:{
 AssumeRolePolicyDocument:structuredClone(r.ExecutionRole.Properties.AssumeRolePolicyDocument),
 ManagedPolicyArns:structuredClone(r.ExecutionRole.Properties.ManagedPolicyArns),
 Policies:[{PolicyName:'RestoreSecrets',PolicyDocument:{Version:'2012-10-17',Statement:[
  {Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:restoreSecrets},
  {Effect:'Allow',Action:'kms:Decrypt',Resource:imported('DataKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('secretsmanager.${AWS::Region}.amazonaws.com')},'ForAnyValue:StringEquals':{'kms:EncryptionContext:SecretARN':restoreSecrets}}},
 ]}}]}};
r.RestoreRole={Type:'AWS::IAM::Role',Properties:{
 AssumeRolePolicyDocument:structuredClone(r.ExecutionRole.Properties.AssumeRolePolicyDocument),
 Policies:[{PolicyName:'ReadRenderExportsOnly',PolicyDocument:{Version:'2012-10-17',Statement:[
  {Effect:'Allow',Action:['s3:GetObject','s3:GetObjectVersion'],Resource:{'Fn::Join':['',['arn:',ref('AWS::Partition'),':s3:::',imported('MigrationBucket'),'/exports/*']]}},
  // The bucket is encrypted with the project's data key; decrypt only through S3.
  {Effect:'Allow',Action:'kms:Decrypt',Resource:imported('DataKeyArn'),Condition:{StringEquals:{'kms:ViaService':sub('s3.${AWS::Region}.amazonaws.com')}}},
 ]}}]}};
const restoreContainer=structuredClone(container);
restoreContainer.Name='render-restore';
restoreContainer.Command=['node','src/db/aws-restore.js'];
restoreContainer.Secrets=[{Name:'STOCKCHIEF_RESTORE_MASTER_SECRET',ValueFrom:master},{Name:'STOCKCHIEF_RESTORE_OWNER_SECRET',ValueFrom:ownerSecret},{Name:'STOCKCHIEF_RESTORE_RUNTIME_SECRET',ValueFrom:applicationSecret}];
restoreContainer.Environment=[{Name:'NODE_ENV',Value:'production'},{Name:'STOCKCHIEF_RESTORE_HOST',Value:imported('Host')},{Name:'STOCKCHIEF_RESTORE_DATABASE',Value:imported('DatabaseName')},{Name:'STOCKCHIEF_RESTORE_WORKDIR',Value:'/tmp'}];
restoreContainer.LogConfiguration=structuredClone(container.LogConfiguration);restoreContainer.LogConfiguration.Options['awslogs-stream-prefix']='render-restore';
r.RestoreTask={Type:'AWS::ECS::TaskDefinition',Properties:{...structuredClone(r.Task.Properties),
 Family:'stockchief-render-restore',Cpu:'1024',Memory:'4096',EphemeralStorage:{SizeInGiB:60},
 ExecutionRoleArn:get('RestoreExecutionRole','Arn'),TaskRoleArn:get('RestoreRole','Arn'),ContainerDefinitions:[restoreContainer]}};
template.Outputs.RestoreTask={Value:ref('RestoreTask')};
// Builds infra/aws-imports/Dockerfile from a source archive uploaded to
// builds/ in the private bucket and pushes it to this stack's repository
// under an immutable tag. No local Docker is required. Billed per build minute.
const buildSpec=['version: 0.2','phases:','  pre_build:','    commands:',
 '      - test -n "$IMAGE_TAG"',
 '      - aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPOSITORY_URI%%/*}"',
 '  build:','    commands:',
 '      - docker build -f infra/aws-imports/Dockerfile --build-arg BASE=public.ecr.aws/docker/library/node:22.23.4-bookworm-slim -t "$REPOSITORY_URI:$IMAGE_TAG" .',
 '      - docker push "$REPOSITORY_URI:$IMAGE_TAG"',
 '  post_build:','    commands:',
 '      - aws ecr describe-images --region "$AWS_REGION" --repository-name stockchief-imports --image-ids imageTag="$IMAGE_TAG" --query "imageDetails[0].imageDigest" --output text'].join('\n');
r.ImageBuildRole={Type:'AWS::IAM::Role',Properties:{
 AssumeRolePolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:'codebuild.amazonaws.com'},Action:'sts:AssumeRole',Condition:{StringEquals:{'aws:SourceAccount':ref('AWS::AccountId')}}}]},
 Policies:[{PolicyName:'BuildAndPushWorkerImage',PolicyDocument:{Version:'2012-10-17',Statement:[
  {Effect:'Allow',Action:['s3:GetObject','s3:GetObjectVersion'],Resource:sub('${Sources.Arn}/builds/*')},
  {Effect:'Allow',Action:'ecr:GetAuthorizationToken',Resource:'*'},
  {Effect:'Allow',Action:['ecr:BatchCheckLayerAvailability','ecr:InitiateLayerUpload','ecr:UploadLayerPart','ecr:CompleteLayerUpload','ecr:PutImage','ecr:BatchGetImage','ecr:GetDownloadUrlForLayer','ecr:DescribeImages'],Resource:get('Images','Arn')},
  {Effect:'Allow',Action:['logs:CreateLogStream','logs:PutLogEvents'],Resource:sub('${Logs.Arn}:*')},
 ]}}]}};
r.ImageBuild={Type:'AWS::CodeBuild::Project',Properties:{
 Name:sub('${AWS::StackName}-worker-image'),ServiceRole:get('ImageBuildRole','Arn'),TimeoutInMinutes:30,QueuedTimeoutInMinutes:30,
 Source:{Type:'S3',Location:sub('${Sources}/builds/stockchief-imports.zip'),BuildSpec:buildSpec},Artifacts:{Type:'NO_ARTIFACTS'},
 Environment:{Type:'LINUX_CONTAINER',ComputeType:'BUILD_GENERAL1_MEDIUM',Image:'aws/codebuild/amazonlinux-x86_64-standard:5.0',PrivilegedMode:true,
  EnvironmentVariables:[{Name:'REPOSITORY_URI',Value:sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${Images}')}]},
 LogsConfig:{CloudWatchLogs:{Status:'ENABLED',GroupName:ref('Logs'),StreamName:'image-build'}}}};
template.Outputs.ImageBuild={Value:ref('ImageBuild')};
template.Outputs.WorkerTask={Value:ref('Task')};
template.Outputs.BootstrapTask={Condition:'Qualification',Value:ref('BootstrapTask')};
template.Outputs.Subnets={Value:imported('SubnetIds')};
template.Outputs.ClientSecurityGroup={Value:imported('ClientSecurityGroupId')};
if(require.main===module)fs.writeFileSync(path.join(__dirname,'template-rds.json'),JSON.stringify(template,null,2)+'\n');
module.exports={template};
