'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{X509Certificate,createHash}=require('node:crypto');
const {connection}=require('../../src/imports/aws-database-connection'),{connectionOptions}=require('../../src/db/postgres');
const secret={engine:'postgres',host:'stockchief-main-postgres.example123.us-east-2.rds.amazonaws.com',port:5432,username:'stockchief_runtime',password:'test-only@:/% not-real',dbname:'stockchief'};
const env={STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify(secret),STOCKCHIEF_IMPORT_DATABASE_NAME:'stockchief'};
test('injected scoped RDS credentials preserve special characters and verify the CA and hostname',()=>{
 const result=connection(env),options=connectionOptions(result.connectionString,{ca:result.ca,requireTls:true});
 assert.equal(options.host,secret.host);assert.equal(options.database,'stockchief');assert.equal(options.user,'stockchief_runtime');assert.equal(options.password,secret.password);
 assert.equal(options.ssl.rejectUnauthorized,true);assert.equal(options.ssl.checkServerIdentity,undefined,'Use the TLS default hostname check, not an accepting override.');
 assert.equal(createHash('sha256').update(result.ca).digest('hex'),'d46e1bdfda05c8e7644e50930806a19b139a222542bf0348082fb59ece2b5fa5');
 const roots=result.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);assert.equal(roots.length,3);
 for(const pem of roots){const c=new X509Certificate(pem);assert(c.ca);assert(c.verify(c.publicKey));assert.match(c.subject,/Amazon RDS us-east-2 Root CA/);}
});
test('wrong role, Region, database, port, ambiguous credentials and an old certificate pin fail without disclosing credentials',()=>{
 for(const changed of [{username:'sc_database_owner'},{host:'database.example.test'},{port:443},{dbname:'wrong_database'},{engine:'mysql'}]){
  assert.throws(()=>connection({...env,STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify({...secret,...changed})}),error=>!error.message.includes(secret.password));
 }
 assert.throws(()=>connection({...env,FOUNDRY_DATABASE_URL:'postgres://old:secret@old.example.test/old'}),/one AWS database credential source/);
 assert.throws(()=>connection({...env,FOUNDRY_DATABASE_TLS_FINGERPRINT256:'old-pin'}),/previous database certificate pin/);
 assert.throws(()=>connection({...env,STOCKCHIEF_IMPORT_DATABASE_SECRET:'malformed secret test-only'}),error=>!error.message.includes('test-only'));
 assert.throws(()=>connection({FOUNDRY_DATABASE_URL:'malformed-secret'}),error=>!error.message.includes('malformed-secret'));
 assert.throws(()=>connection({FOUNDRY_DATABASE_URL:'https://db.example.test/stockchief?sslmode=verify-full'}),/PostgreSQL database URL/);
});
test('qualification credentials cannot be pointed at the restored customer database',()=>{
 const qualification={username:'stockchief_qualification',password:'fake-test-only',dbname:'stockchief_qualification'},settings={STOCKCHIEF_IMPORT_DATABASE_ROLE:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_HOST:secret.host,STOCKCHIEF_IMPORT_DATABASE_NAME:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify(qualification)};
 const options=connectionOptions(connection(settings).connectionString);assert.equal(options.database,'stockchief_qualification');assert.equal(options.user,'stockchief_qualification');
 assert.throws(()=>connection({...settings,STOCKCHIEF_IMPORT_DATABASE_NAME:'stockchief',STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify({...qualification,dbname:'stockchief'})}),/only the isolated synthetic database/);
 assert.throws(()=>connection({...settings,STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify({...qualification,host:'substituted.example.test'})}),/scoped PostgreSQL application secret/);
});
