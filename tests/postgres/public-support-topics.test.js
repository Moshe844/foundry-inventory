'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');

// A support link opens the form for what it is about, not always "what went wrong".
test('each public support link opens a form for its own topic',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const visitor=request.agent(app);
 const form=async path=>{const page=await visitor.get(path);assert.equal(page.status,200,path);
  const section=/data-support-topic="([a-z]+)"[\s\S]*?<h2>([^<]+)<\/h2>[\s\S]*?name="subject"[^>]*value="([^"]*)"[\s\S]*?<span>([^<]+)<\/span><textarea/.exec(page.text);
  assert.ok(section,path+' shows the support form');return {topic:section[1],heading:section[2],subject:section[3],question:section[4]};};
 assert.deepEqual(await form('/support?topic=connection&about=Shopify'),{topic:'connection',heading:'Ask about a connection',subject:'Turn on Shopify',question:'Which system do you use, and what should StockChief do with it?'});
 assert.deepEqual(await form('/contact?topic=security'),{topic:'security',heading:'Ask a security question',subject:'Security question',question:'What would you like to know about how StockChief protects your data?'});
 assert.equal((await form('/contact?topic=migration')).heading,'Plan a complex migration');
 assert.equal((await form('/support?topic=billing')).heading,'Change your plan');
 assert.equal((await form('/support?topic=help')).heading,'How can we help?');
 assert.deepEqual(await form('/support'),{topic:'problem',heading:'Tell us what happened',subject:'',question:'What were you doing, and what went wrong?'},'a plain link is still the problem report');
 assert.equal((await form('/support?topic=connection&about=%3Cscript%3EShop%22ify')).subject,'Turn on scriptShopify','a name from the address is kept to plain characters');
 // Every public page links to support with a topic.
 for(const path of ['/integrations','/pricing','/switching','/control']){const page=await visitor.get(path);
  assert.doesNotMatch(page.text,/href="\/(support|contact)"/,path+' links name their topic');}
});
