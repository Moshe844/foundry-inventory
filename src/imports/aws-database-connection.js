'use strict';
const fs=require('node:fs'),path=require('node:path');
const {databaseAddress}=require('./aws-worker');
const ohioRds=/^[a-z0-9-]+\.[a-z0-9-]+\.us-east-2\.rds\.amazonaws\.com$/;

function connection(env=process.env){
 let address;
 if(env.STOCKCHIEF_IMPORT_DATABASE_SECRET){
  if(env.FOUNDRY_DATABASE_URL||env.DATABASE_URL)throw new Error('Choose one AWS database credential source before starting the worker.');
  let value;try{value=JSON.parse(env.STOCKCHIEF_IMPORT_DATABASE_SECRET);}catch{throw new Error('The injected AWS database secret must be valid JSON.');}
  const role=env.STOCKCHIEF_IMPORT_DATABASE_ROLE||'stockchief_runtime',host=env.STOCKCHIEF_IMPORT_DATABASE_HOST||value?.host;
  if(!value||typeof value!=='object'||!ohioRds.test(host)||value.host&&value.host!==host||!['stockchief_runtime','stockchief_qualification'].includes(role)||value.username!==role||typeof value.password!=='string'||!value.password||Number(value.port??5432)!==5432||value.engine&&value.engine!=='postgres')throw new Error('The AWS worker needs the scoped PostgreSQL application secret in us-east-2.');
  const name=env.STOCKCHIEF_IMPORT_DATABASE_NAME||value.dbname;
  if(typeof name!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(name)||value.dbname&&value.dbname!==name)throw new Error('The AWS application secret and approved database name must match.');
  if(role==='stockchief_qualification'&&name!=='stockchief_qualification')throw new Error('Qualification workers can access only the isolated synthetic database.');
  address=new URL('postgresql://'+host+':5432/'+name);
  address.username=encodeURIComponent(value.username);address.password=encodeURIComponent(value.password);address.searchParams.set('sslmode','verify-full');
 }else{
  const text=databaseAddress(env.FOUNDRY_DATABASE_URL||env.DATABASE_URL);
  address=new URL(text);
 }
 if(ohioRds.test(address.hostname)){
  if(env.FOUNDRY_DATABASE_TLS_FINGERPRINT256)throw new Error('Remove the previous database certificate pin before using verified RDS hostname validation.');
  return {connectionString:databaseAddress(address.href),ca:fs.readFileSync(path.join(__dirname,'../db/certificates/aws-rds-us-east-2.pem'),'utf8')};
 }
 return {connectionString:databaseAddress(address.href)};
}
module.exports={connection};
