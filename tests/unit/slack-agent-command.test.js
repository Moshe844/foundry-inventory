'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const slack=require('../../src/connections/slack-agent-command');

const time='1794340800';
const creds={secret:'ad'.repeat(16),team:'TSTOCK1',app:'ASTOCK1'};
const callback='https://hooks.slack.com/commands/TSTOCK1/1234567890/abcdefghijabcdefghij';
const form={team_id:creds.team,api_app_id:creds.app,user_id:'USTOCK1',command:'/stockchief',response_url:callback,text:'What is on hand for SKU ABC?'};
function parse(fields,extra={}){
  const raw=Buffer.from(new URLSearchParams(fields).toString());
  return slack.parse(raw,creds,{timestamp:time,signature:slack.sign(raw,time,creds.secret),now:Number(time)*1000,...extra});
}

test('accepts the exact signed Slack command and returns a private plain-text response',()=>{
  assert.deepEqual(parse(form),{team:creds.team,app:creds.app,user:'USTOCK1',text:form.text,callback});
  const response=slack.reply('<!channel> user-entered text');
  assert.equal(response.response_type,'ephemeral');
  assert.equal(response.blocks[0].text.type,'plain_text');
  assert.equal(response.blocks[0].text.text,'<!channel> user-entered text');
  const long=slack.reply('Stock '.repeat(1000)+'\n\nAI credits used 5.');
  assert(long.blocks[0].text.text.length<3000);
  assert.match(long.blocks[0].text.text,/This answer is shortened/);
  assert.match(long.blocks[0].text.text,/AI credits used 5\.$/);
});

test('rejects modified, stale, duplicate, wrong-team and off-origin input before any response',()=>{
  assert.throws(()=>parse(form,{now:Number(time)*1000+301000}),/could not be verified/);
  assert.throws(()=>parse(form,{signature:'v0='+'0'.repeat(64)}),/could not be verified/);
  assert.throws(()=>parse([...Object.entries(form),['user_id','UOTHER1']]),/could not be verified/);
  assert.throws(()=>parse({...form,team_id:'TOTHER1'}),/outside the connected team/);
  assert.throws(()=>parse({...form,api_app_id:'AOTHER1'}),/outside the connected team/);
  assert.throws(()=>parse({...form,response_url:callback.replace('hooks.slack.com','hooks.slack.com.example.test')}),/response address/);
  assert.throws(()=>parse({...form,response_url:callback.replace('TSTOCK1','TOTHER1')}),/response address/);
  assert.throws(()=>parse({...form,response_url:callback+'?x=1'}),/response address/);
});
