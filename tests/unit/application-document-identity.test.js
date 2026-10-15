'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{postgresPageRenderer}=require('../../src/web/postgres-page-renderer');
function render({layout=false,status=200,workspaceId='offline-workspace',error=null,standalone=false}={}){
 const headers={},req={ctx:workspaceId?{workspaceId}:null,method:'GET',originalUrl:'/unfamiliar-document',path:'/unfamiliar-document',protocol:'https',get:()=> 'offline.example.test'},res={statusCode:status,locals:{},set:(k,v)=>{headers[k]=v;},send:body=>({body,headers}),render:(view,data,callback)=>callback?callback(error,'<article>Business document</article>'):{body:data.body,headers}},next=e=>({error:e,headers});
 postgresPageRenderer(req,res,next);return standalone?res.render('unfamiliar-view',{layout:false}):res.page('unfamiliar-view',{layout});
}
test('direct document and shell render paths share authenticated application identity',()=>{
 for(const standalone of [true,false]){
  for(const layout of [false,true])assert.equal(render({layout,standalone}).headers['X-StockChief-Page'],'1');
  for(const status of [400,403,404,500])assert.equal(render({status,standalone}).headers['X-StockChief-Page'],undefined);
  assert.equal(render({workspaceId:null,standalone}).headers['X-StockChief-Page'],undefined);assert.equal(render({error:Error('Render failed'),standalone}).headers['X-StockChief-Page'],undefined);
 }
});
