'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {flash}=require('../../src/web/middleware');
const {postgresPageRenderer}=require('../../src/web/postgres-page-renderer');

test('background requests cannot consume a confirmation before the next rendered page',()=>{
  const session={flash:[{type:'success',message:'Email queued'}]};
  const background={session,path:'/favicon.ico',method:'GET'};
  const backgroundResponse={locals:{}};
  flash(background,backgroundResponse,()=>{});
  assert.equal(session.flash.length,1);

  const request={session,path:'/settings',originalUrl:'/settings',get:()=> 'localhost'};
  let rendered=null;
  const response={locals:{},render(view,data,callback){
    if(callback)return callback(null,'settings body');
    rendered={view,data};
  }};
  flash(request,response,()=>{});
  postgresPageRenderer(request,response,()=>{});
  response.page('settings',{title:'Settings',suppressBack:true});
  assert.equal(rendered.view,'layout');
  assert.deepEqual(rendered.data.flash,[{type:'success',message:'Email queued'}]);
  assert.deepEqual(session.flash,[]);
});
