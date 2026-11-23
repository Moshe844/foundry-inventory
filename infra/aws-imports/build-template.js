'use strict';
const fs=require('node:fs'),path=require('node:path');
const ref=name=>({Ref:name}),sub=value=>({'Fn::Sub':value}),get=(name,attribute)=>({'Fn::GetAtt':[name,attribute]});
const roleTrust=service=>({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Service:service},Action:'sts:AssumeRole'}]});
const resources={};
const add=(name,Type,Properties,other={})=>resources[name]={Type,Properties,...other};

add('Sources','AWS::S3::Bucket',{
 VersioningConfiguration:{Status:'Enabled'},
 BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]},
 PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true},
 OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},
 CorsConfiguration:{CorsRules:[{AllowedOrigins:[ref('ApplicationOrigin')],AllowedMethods:['POST'],AllowedHeaders:['*'],ExposedHeaders:['x-amz-version-id'],MaxAge:600}]},
 LifecycleConfiguration:{Rules:[{Id:'TemporaryImportSources',Status:'Enabled',Prefix:'sources/',ExpirationInDays:7,NoncurrentVersionExpiration:{NoncurrentDays:7},AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}]},
},{DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'});
add('SourcePolicy','AWS::S3::BucketPolicy',{Bucket:ref('Sources'),PolicyDocument:{Version:'2012-10-17',Statement:[{Sid:'DenyInsecureTransport',Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[get('Sources','Arn'),sub('${Sources.Arn}/*')],Condition:{Bool:{'aws:SecureTransport':'false'}}}]}});
add('DeadLetters','AWS::SQS::Queue',{MessageRetentionPeriod:1209600,SqsManagedSseEnabled:true});
add('ImportQueue','AWS::SQS::Queue',{MessageRetentionPeriod:345600,SqsManagedSseEnabled:true,VisibilityTimeout:60,ReceiveMessageWaitTimeSeconds:20,RedrivePolicy:{deadLetterTargetArn:get('DeadLetters','Arn'),maxReceiveCount:5}});
add('QueuePolicy','AWS::SQS::QueuePolicy',{Queues:[ref('ImportQueue'),ref('DeadLetters')],PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Deny',Principal:'*',Action:'sqs:*',Resource:[get('ImportQueue','Arn'),get('DeadLetters','Arn')],Condition:{Bool:{'aws:SecureTransport':'false'}}}]}});
add('Images','AWS::ECR::Repository',{RepositoryName:'stockchief-imports',ImageTagMutability:'IMMUTABLE',ImageScanningConfiguration:{ScanOnPush:true},LifecyclePolicy:{LifecyclePolicyText:JSON.stringify({rules:[{rulePriority:1,description:'Remove untagged build layers after seven days',selection:{tagStatus:'untagged',countType:'sinceImagePushed',countUnit:'days',countNumber:7},action:{type:'expire'}}]})}},{DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'});
add('Logs','AWS::Logs::LogGroup',{RetentionInDays:14});
add('ExecutionRole','AWS::IAM::Role',{AssumeRolePolicyDocument:roleTrust('ecs-tasks.amazonaws.com'),ManagedPolicyArns:[sub('arn:${AWS::Partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')],Policies:[{PolicyName:'OnlyImportDatabaseSecret',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:'secretsmanager:GetSecretValue',Resource:ref('DatabaseSecretArn')}]}}]});
add('ImportRole','AWS::IAM::Role',{AssumeRolePolicyDocument:roleTrust('ecs-tasks.amazonaws.com'),Policies:[{PolicyName:'ReadFrozenSourcesAndReceiveWakeSignals',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['s3:GetObject','s3:GetObjectVersion'],Resource:sub('${Sources.Arn}/sources/*')},{Effect:'Allow',Action:['sqs:ReceiveMessage','sqs:DeleteMessage','sqs:GetQueueAttributes'],Resource:get('ImportQueue','Arn')}]}}]});
// This is an application identity, never a console/team-member identity. No
// access key is created or stored in CloudFormation outputs/state.
add('RenderApplication','AWS::IAM::User',{Policies:[{PolicyName:'UploadAndSignalOnly',PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Allow',Action:['s3:PutObject','s3:GetObject'],Resource:sub('${Sources.Arn}/sources/*')},{Effect:'Allow',Action:'sqs:SendMessage',Resource:get('ImportQueue','Arn')}]}}]});

add('Network','AWS::EC2::VPC',{CidrBlock:'10.84.0.0/16',EnableDnsSupport:true,EnableDnsHostnames:true});
add('Gateway','AWS::EC2::InternetGateway',{});
add('GatewayAttachment','AWS::EC2::VPCGatewayAttachment',{VpcId:ref('Network'),InternetGatewayId:ref('Gateway')});
const az={'Fn::Select':[0,{'Fn::GetAZs':''}]};
add('PublicSubnet','AWS::EC2::Subnet',{VpcId:ref('Network'),CidrBlock:'10.84.0.0/24',AvailabilityZone:az,MapPublicIpOnLaunch:false});
add('WorkerSubnet','AWS::EC2::Subnet',{VpcId:ref('Network'),CidrBlock:'10.84.1.0/24',AvailabilityZone:az,MapPublicIpOnLaunch:false});
add('PublicRoutes','AWS::EC2::RouteTable',{VpcId:ref('Network')});
add('PublicRouteAssociation','AWS::EC2::SubnetRouteTableAssociation',{SubnetId:ref('PublicSubnet'),RouteTableId:ref('PublicRoutes')});
add('InternetRoute','AWS::EC2::Route',{RouteTableId:ref('PublicRoutes'),DestinationCidrBlock:'0.0.0.0/0',GatewayId:ref('Gateway')},{DependsOn:'GatewayAttachment'});
add('FixedEgress','AWS::EC2::EIP',{Domain:'vpc'},{DependsOn:'GatewayAttachment'});
add('Nat','AWS::EC2::NatGateway',{SubnetId:ref('PublicSubnet'),AllocationId:get('FixedEgress','AllocationId')},{DependsOn:'InternetRoute'});
add('WorkerRoutes','AWS::EC2::RouteTable',{VpcId:ref('Network')});
add('WorkerRouteAssociation','AWS::EC2::SubnetRouteTableAssociation',{SubnetId:ref('WorkerSubnet'),RouteTableId:ref('WorkerRoutes')});
add('WorkerInternetRoute','AWS::EC2::Route',{RouteTableId:ref('WorkerRoutes'),DestinationCidrBlock:'0.0.0.0/0',NatGatewayId:ref('Nat')});
add('S3Endpoint','AWS::EC2::VPCEndpoint',{VpcId:ref('Network'),VpcEndpointType:'Gateway',ServiceName:sub('com.amazonaws.${AWS::Region}.s3'),RouteTableIds:[ref('WorkerRoutes')]});
add('WorkerFirewall','AWS::EC2::SecurityGroup',{GroupDescription:'No inbound traffic; HTTPS and the approved database IP only',VpcId:ref('Network'),SecurityGroupEgress:[{IpProtocol:'tcp',FromPort:443,ToPort:443,CidrIp:'0.0.0.0/0'},{IpProtocol:'tcp',FromPort:5432,ToPort:5432,CidrIp:ref('DatabaseIpv4Cidr')}]});
add('Cluster','AWS::ECS::Cluster',{});
add('Task','AWS::ECS::TaskDefinition',{Family:'stockchief-imports',RequiresCompatibilities:['FARGATE'],NetworkMode:'awsvpc',Cpu:'1024',Memory:'2048',ExecutionRoleArn:get('ExecutionRole','Arn'),TaskRoleArn:get('ImportRole','Arn'),RuntimePlatform:{OperatingSystemFamily:'LINUX',CpuArchitecture:'X86_64'},ContainerDefinitions:[{
 Name:'imports',Image:ref('WorkerImage'),Essential:true,ReadonlyRootFilesystem:false,StopTimeout:120,
 LinuxParameters:{InitProcessEnabled:true},
 Environment:[{Name:'NODE_ENV',Value:'production'},{Name:'FOUNDRY_SKIP_LOCAL_ENV',Value:'1'},{Name:'STOCKCHIEF_IMPORT_BACKEND',Value:'aws'},{Name:'AWS_REGION',Value:ref('AWS::Region')},{Name:'STOCKCHIEF_IMPORT_BUCKET',Value:ref('Sources')},{Name:'STOCKCHIEF_IMPORT_QUEUE_URL',Value:ref('ImportQueue')},{Name:'STOCKCHIEF_IMPORT_COPY',Value:'true'}],
 Secrets:[{Name:'FOUNDRY_DATABASE_URL',ValueFrom:ref('DatabaseSecretArn')}],
 LogConfiguration:{LogDriver:'awslogs',Options:{'awslogs-group':ref('Logs'),'awslogs-region':ref('AWS::Region'),'awslogs-stream-prefix':'imports','mode':'non-blocking','max-buffer-size':'4m'}}
}]});
add('Workers','AWS::ECS::Service',{Cluster:ref('Cluster'),TaskDefinition:ref('Task'),LaunchType:'FARGATE',DesiredCount:ref('WorkerCount'),DeploymentConfiguration:{MaximumPercent:100,MinimumHealthyPercent:0,DeploymentCircuitBreaker:{Enable:true,Rollback:true}},NetworkConfiguration:{AwsvpcConfiguration:{AssignPublicIp:'DISABLED',Subnets:[ref('WorkerSubnet')],SecurityGroups:[ref('WorkerFirewall')]}}},{DependsOn:'WorkerInternetRoute'});
add('Alerts','AWS::SNS::Topic',{Subscription:[{Protocol:'email',Endpoint:ref('AlertEmail')}]});
for(const [name,queue,metric,threshold]of [['DeadLetterAlarm','DeadLetters','ApproximateNumberOfMessagesVisible',0],['QueueDelayAlarm','ImportQueue','ApproximateAgeOfOldestMessage',300]]){
 add(name,'AWS::CloudWatch::Alarm',{Namespace:'AWS/SQS',MetricName:metric,Dimensions:[{Name:'QueueName',Value:get(queue,'QueueName')}],Statistic:'Maximum',Period:60,EvaluationPeriods:2,Threshold:threshold,ComparisonOperator:'GreaterThanThreshold',TreatMissingData:'notBreaching',AlarmActions:[ref('Alerts')]});
}
add('Budget','AWS::Budgets::Budget',{Budget:{BudgetName:sub('${AWS::StackName}-monthly'),BudgetType:'COST',TimeUnit:'MONTHLY',BudgetLimit:{Amount:ref('MonthlyBudget'),Unit:'USD'}},NotificationsWithSubscribers:[50,80,100].map(Threshold=>({Notification:{NotificationType:'ACTUAL',ComparisonOperator:'GREATER_THAN',Threshold,ThresholdType:'PERCENTAGE'},Subscribers:[{SubscriptionType:'EMAIL',Address:ref('AlertEmail')}]}))});

const template={AWSTemplateFormatVersion:'2010-09-09',Description:'StockChief isolated imports: private versioned sources, durable wake queue, bounded Fargate and fixed outbound IP. Creates billable resources. Review the cost worksheet before deployment.',
 Rules:{SelectedRegion:{Assertions:[{Assert:{'Fn::Equals':[ref('AWS::Region'),'us-east-2']},AssertDescription:'This project is assigned to us-east-2.'}]}},
 Parameters:{
  ApplicationOrigin:{Type:'String',AllowedPattern:'https://[a-z0-9.-]+',Description:'Exact HTTPS application origin allowed to upload; no wildcard.'},
  DatabaseSecretArn:{Type:'String',AllowedPattern:'arn:aws:secretsmanager:us-east-2:[0-9]{12}:secret:stockchief/imports/[A-Za-z0-9/_+=.@-]+',Description:'Approved certificate-verified external PostgreSQL URL; never a Render private hostname.'},
  DatabaseIpv4Cidr:{Type:'String',AllowedPattern:'[0-9]{1,3}(\\.[0-9]{1,3}){3}/32',Description:'Resolved, approved database IPv4 address only.'},
  WorkerImage:{Type:'String',AllowedPattern:'[0-9]{12}\\.dkr\\.ecr\\.us-east-2\\.amazonaws\\.com/stockchief-imports@sha256:[a-f0-9]{64}',Description:'Reviewed immutable image digest; bootstrap with WorkerCount=0, build/push, then update.'},
  WorkerCount:{Type:'Number',Default:0,AllowedValues:[0,1,2],Description:'Zero until credentials, network approval and qualification are ready. NAT still costs money at zero.'},
  AlertEmail:{Type:'String',AllowedPattern:'[^@\\s]+@[^@\\s]+\\.[^@\\s]+',Description:'Owner email; SNS requires confirmation.'},
  MonthlyBudget:{Type:'Number',Default:100,MinValue:1,MaxValue:1000,Description:'Alert threshold, not a hard spending cap. Set a project spend limit separately in AWS Settings.'},
 },Resources:resources,
 Outputs:{Bucket:{Value:ref('Sources')},QueueUrl:{Value:ref('ImportQueue')},Repository:{Value:get('Images','RepositoryUri')},DatabaseAllowlistIp:{Value:sub('${FixedEgress}/32')},RenderApplicationIdentity:{Value:ref('RenderApplication')},Cluster:{Value:ref('Cluster')},Service:{Value:get('Workers','Name')}}};
if(require.main===module)fs.writeFileSync(path.join(__dirname,'template.json'),JSON.stringify(template,null,2)+'\n');
module.exports={template};
