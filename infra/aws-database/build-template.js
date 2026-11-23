'use strict';
const fs=require('node:fs'),path=require('node:path');
const ref=name=>({Ref:name}),sub=value=>({'Fn::Sub':value}),get=(name,attribute)=>({'Fn::GetAtt':[name,attribute]});
const resources={},parameters={
 NamePrefix:{Type:'String',Default:'stockchief-production',AllowedPattern:'[a-z][a-z0-9-]{2,29}',Description:'Unique deployment prefix; existing databases are never replaced by this preparation.'},
 DatabaseName:{Type:'String',Default:'stockchief',AllowedPattern:'[a-zA-Z][a-zA-Z0-9_]{0,62}'},
 EngineVersion:{Type:'String',Default:'17.11',AllowedPattern:'17\\.[0-9]+',Description:'Latest available PostgreSQL 17 minor verified in the selected Region; preserve the source major for this migration.'},
 DatabaseClass:{Type:'String',Default:'db.m7g.xlarge',AllowedValues:['db.m7g.large','db.m7g.xlarge'],Description:'Reviewed non-burstable choices: 2 vCPU/8 GiB or 4 vCPU/16 GiB. The class remains subject to cost approval and qualification.'},
 DeploymentPhase:{Type:'String',Default:'qualification',AllowedValues:['qualification','production'],Description:'Rehearse on the isolated target first; production enables a synchronous standby in another zone.'},
 AllocatedStorage:{Type:'Number',Default:50,AllowedValues:[50]},
 MaxAllocatedStorage:{Type:'Number',Default:100,AllowedValues:[100],Description:'Storage autoscaling ceiling, shared across customers. The database cannot shrink after growth.'},
 AllowRestrictedRenderAccess:{Type:'String',Default:'false',AllowedValues:['false','true'],Description:'Explicitly approved exception for the Render-hosted application. False keeps the endpoint private; true requires confirmed Render outbound CIDRs.'},
};
const conditions={RestrictedRenderAccess:{'Fn::Equals':[ref('AllowRestrictedRenderAccess'),'true']},Production:{'Fn::Equals':[ref('DeploymentPhase'),'production']}};
for(let i=1;i<=8;i++){
 parameters['RenderCidr'+i]={Type:'String',Default:'',AllowedPattern:'^$|^([0-9]{1,3}\\.){3}[0-9]{1,3}/(1[6-9]|2[0-9]|3[0-2])$',Description:'Verified Render outbound range only; never the internet. Leave unused entries empty.'};
 conditions['RenderRange'+i]={'Fn::And':[{'Condition':'RestrictedRenderAccess'},{'Fn::Not':[{'Fn::Equals':[ref('RenderCidr'+i),'']}]}]};
}
function add(name,type,properties,why,must=[],extra={}){resources[name]={Type:type,Properties:properties,Metadata:{'com.aws.cloudformation.Context':{why,must}},...extra};}
const retain={DeletionPolicy:'Retain',UpdateReplacePolicy:'Retain'};
add('Network','AWS::EC2::VPC',{CidrBlock:'10.85.0.0/16',EnableDnsSupport:true,EnableDnsHostnames:true},'Colocate the database and import tasks; no public database access by default.',['Only the assigned Region; do not attach other customer networks.']);
add('Gateway','AWS::EC2::InternetGateway',{},'Outbound AWS service access for import tasks without a permanently charged NAT gateway.');
add('GatewayAttachment','AWS::EC2::VPCGatewayAttachment',{VpcId:ref('Network'),InternetGatewayId:ref('Gateway')},'Public task IPs carry outbound connections only; task security groups accept no inbound connections.');
for(let i=0;i<2;i++){
 add('Subnet'+i,'AWS::EC2::Subnet',{VpcId:ref('Network'),CidrBlock:'10.85.'+i+'.0/24',AvailabilityZone:{'Fn::Select':[i,{'Fn::GetAZs':''}]},MapPublicIpOnLaunch:false},'Distinct availability zones support database failover.',['RDS remains private unless the reviewed Render exception is explicitly enabled.']);
}
add('Routes','AWS::EC2::RouteTable',{VpcId:ref('Network')},'Shared outbound routing; no NAT gateway or public listener.');
add('InternetRoute','AWS::EC2::Route',{RouteTableId:ref('Routes'),DestinationCidrBlock:'0.0.0.0/0',GatewayId:ref('Gateway')},'Egress route for tasks explicitly assigned a public IP.',[],{DependsOn:'GatewayAttachment'});
for(let i=0;i<2;i++)add('RouteAssociation'+i,'AWS::EC2::SubnetRouteTableAssociation',{SubnetId:ref('Subnet'+i),RouteTableId:ref('Routes')},'Associate both database/task subnets with the same reviewed routing.');
add('ClientFirewall','AWS::EC2::SecurityGroup',{VpcId:ref('Network'),GroupDescription:'StockChief import tasks: no inbound traffic',SecurityGroupEgress:[{IpProtocol:'tcp',FromPort:443,ToPort:443,CidrIp:'0.0.0.0/0'}]},'Task identity grants private database access; HTTPS reaches S3, SQS and image endpoints.',['No ingress rules; database access is restricted to the database group.']);
add('DatabaseFirewall','AWS::EC2::SecurityGroup',{VpcId:ref('Network'),GroupDescription:'StockChief database: import tasks and explicitly approved Render ranges only',SecurityGroupIngress:[{IpProtocol:'tcp',FromPort:5432,ToPort:5432,SourceSecurityGroupId:ref('ClientFirewall')}],SecurityGroupEgress:[{IpProtocol:'-1',CidrIp:'127.0.0.1/32'}]},'Private task traffic is allowed by security-group identity, not a shared internet range.',['Never allow 0.0.0.0/0 or ::/0 to PostgreSQL.']);
add('ClientDatabaseEgress','AWS::EC2::SecurityGroupEgress',{GroupId:ref('ClientFirewall'),IpProtocol:'tcp',FromPort:5432,ToPort:5432,DestinationSecurityGroupId:ref('DatabaseFirewall')},'Avoid a security-group dependency cycle while restricting database egress.');
for(let i=1;i<=8;i++)add('RenderIngress'+i,'AWS::EC2::SecurityGroupIngress',{GroupId:ref('DatabaseFirewall'),IpProtocol:'tcp',FromPort:5432,ToPort:5432,CidrIp:ref('RenderCidr'+i)},'Opt-in connectivity from a verified Render region; TLS and database authentication remain mandatory.',['Requires explicit network approval and a confirmed outbound CIDR.'],{Condition:'RenderRange'+i});
add('DataKey','AWS::KMS::Key',{Description:'StockChief database, managed credentials and migration evidence',EnableKeyRotation:true,PendingWindowInDays:30,KeyPolicy:{Version:'2012-10-17',Statement:[
 {Sid:'EnableProjectIamPermissions',Effect:'Allow',Principal:{AWS:sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root')},Action:'kms:*',Resource:'*'},
 {Sid:'EncryptDatabaseLogs',Effect:'Allow',Principal:{Service:sub('logs.${AWS::Region}.amazonaws.com')},Action:['kms:Encrypt*','kms:Decrypt*','kms:ReEncrypt*','kms:GenerateDataKey*','kms:Describe*'],Resource:'*',Condition:{ArnEquals:{'kms:EncryptionContext:aws:logs:arn':sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/rds/instance/${NamePrefix}-postgres/postgresql')}}},
]}},'Retain decryptability of database backups, credentials and migration evidence.',['Do not delete the key while retained data exists.'],retain);
add('DatabaseLogs','AWS::Logs::LogGroup',{LogGroupName:sub('/aws/rds/instance/${NamePrefix}-postgres/postgresql'),KmsKeyId:get('DataKey','Arn'),RetentionInDays:14},'Encrypted database security/slow-query logs with bounded retention.',[],retain);
add('Parameters','AWS::RDS::DBParameterGroup',{Family:'postgres17',Description:'StockChief: verified TLS and normalized performance diagnostics',Parameters:{'rds.force_ssl':'1',shared_preload_libraries:'pg_stat_statements',track_io_timing:'1','pg_stat_statements.track_utility':'0',log_parameter_max_length:'0',log_parameter_max_length_on_error:'0'}},'Preserve PostgreSQL semantics and measure database work without logging bind values.',['TLS cannot be disabled; do not log passwords or customer query parameters.']);
add('DatabaseSubnets','AWS::RDS::DBSubnetGroup',{DBSubnetGroupDescription:'Two-zone StockChief database subnets',SubnetIds:[ref('Subnet0'),ref('Subnet1')]},'Automatic standby failover requires at least two availability zones.');
add('Database','AWS::RDS::DBInstance',{
 DBInstanceIdentifier:sub('${NamePrefix}-postgres'),DBName:ref('DatabaseName'),Engine:'postgres',EngineVersion:ref('EngineVersion'),DBInstanceClass:ref('DatabaseClass'),Port:5432,
 AllocatedStorage:ref('AllocatedStorage'),MaxAllocatedStorage:ref('MaxAllocatedStorage'),StorageType:'gp3',StorageEncrypted:true,KmsKeyId:get('DataKey','Arn'),
 MultiAZ:{'Fn::If':['Production',true,false]},PubliclyAccessible:{'Fn::If':['RestrictedRenderAccess',true,false]},VPCSecurityGroups:[ref('DatabaseFirewall')],DBSubnetGroupName:ref('DatabaseSubnets'),DBParameterGroupName:ref('Parameters'),
 MasterUsername:'sc_database_owner',ManageMasterUserPassword:true,MasterUserSecret:{KmsKeyId:get('DataKey','Arn')},
 BackupRetentionPeriod:7,DeletionProtection:true,AutoMinorVersionUpgrade:true,AllowMajorVersionUpgrade:false,CopyTagsToSnapshot:true,
 EnablePerformanceInsights:true,PerformanceInsightsRetentionPeriod:7,PerformanceInsightsKMSKeyId:get('DataKey','Arn'),EnableCloudwatchLogsExports:['postgresql'],
 Tags:[{Key:'created_by',Value:'rds-oss-skill'},{Key:'generation_model',Value:'unknown'},{Key:'workload',Value:'stockchief'},{Key:'phase',Value:ref('DeploymentPhase')}],
},'Managed PostgreSQL retains transactions, advisory locks, unique constraints and exact numeric behavior.',['Source remains authoritative until restore, correctness, performance and connection checks pass.','Retain the source and snapshots through the approved recovery window.','No major-version upgrade during this move.'],{...retain,DependsOn:'DatabaseLogs'});
add('ApplicationSecret','AWS::SecretsManager::Secret',{KmsKeyId:get('DataKey','Arn'),Description:'StockChief database-scoped application role; bootstrap before starting any worker',GenerateSecretString:{SecretStringTemplate:JSON.stringify({username:'stockchief_runtime'}),GenerateStringKey:'password',PasswordLength:40,ExcludePunctuation:true}},'Use a database-scoped application role rather than the RDS owner in web/worker processes.',['No plaintext credentials in parameters, repository, outputs or logs.'],retain);
add('ApplicationSecretAttachment','AWS::SecretsManager::SecretTargetAttachment',{SecretId:ref('ApplicationSecret'),TargetId:ref('Database'),TargetType:'AWS::RDS::DBInstance'},'Attach endpoint metadata only; this does not create the application role or restore records.',['A verified bootstrap/restore must create the database-scoped role before activation.']);
add('MigrationEvidence','AWS::S3::Bucket',{
 BucketEncryption:{ServerSideEncryptionConfiguration:[{ServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms',KMSMasterKeyID:get('DataKey','Arn')}}]},
 PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true},VersioningConfiguration:{Status:'Enabled'},OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]},
 LifecycleConfiguration:{Rules:[{Id:'IncompleteTransfersOnly',Status:'Enabled',AbortIncompleteMultipartUpload:{DaysAfterInitiation:7}}]},
},'Keep a versioned, encrypted migration snapshot and verification manifest without automatic deletion of valid evidence.',['No public downloads; use scoped roles and frozen object versions.'],retain);
add('MigrationEvidencePolicy','AWS::S3::BucketPolicy',{Bucket:ref('MigrationEvidence'),PolicyDocument:{Version:'2012-10-17',Statement:[{Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[get('MigrationEvidence','Arn'),sub('${MigrationEvidence.Arn}/*')],Condition:{Bool:{'aws:SecureTransport':'false'}}}]}},'Require encrypted transport for backup evidence.');
const template={AWSTemplateFormatVersion:'2010-09-09',Description:'StockChief database migration target: retain the source while qualifying an encrypted PostgreSQL standby and colocated imports.',
 Metadata:{AWSToolsMetrics:{AWSAgentToolkit:'aws-cloudformation@3'},'com.aws.cloudformation.Context':{ref:['README.md'],must:['Create only after the reviewed recurring cost and service/network choices are approved.','Keep live checkout and approved commercial entitlements unchanged.']}},
 Parameters:parameters,Conditions:conditions,
 Rules:{SelectedRegion:{Assertions:[{Assert:{'Fn::Equals':[ref('AWS::Region'),'us-east-2']},AssertDescription:'This project is assigned to us-east-2.'}]},RenderException:{RuleCondition:{'Fn::Equals':[ref('AllowRestrictedRenderAccess'),'true']},Assertions:[{Assert:{'Fn::Not':[{'Fn::Equals':[ref('RenderCidr1'),'']}]},AssertDescription:'Restricted public access requires a verified Render outbound range.'}]}},
 Resources:resources,Outputs:{
  Host:{Description:'Certificate-verified PostgreSQL endpoint, never a credential.',Value:get('Database','Endpoint.Address')},
  MasterSecretArn:{Description:'Managed administrative secret: bootstrap/restore only.',Value:get('Database','MasterUserSecret.SecretArn')},
  ApplicationSecretArn:{Description:'Application role secret: role must be created and qualified before activation.',Value:ref('ApplicationSecret')},
  VpcId:{Description:'Pass to the colocated import stack.',Value:ref('Network')},
  SubnetIds:{Description:'Import task subnets; public task IPs permit HTTPS egress without a NAT gateway.',Value:{'Fn::Join':[',',[ref('Subnet0'),ref('Subnet1')]]}},
  ClientSecurityGroupId:{Description:'Import tasks only; no inbound ports.',Value:ref('ClientFirewall')},
  MigrationBucket:{Description:'Private retained migration evidence.',Value:ref('MigrationEvidence')},
 }};
if(require.main===module)fs.writeFileSync(path.join(__dirname,'template.json'),JSON.stringify(template,null,2)+'\n');
module.exports={template};
