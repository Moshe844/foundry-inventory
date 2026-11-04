'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),pagination=require('../../src/web/presentation/pagination');
const request=query=>({query,session:{},originalUrl:'/returns?'+new URLSearchParams(query)});
test('retained return offsets keep their exact position and produce canonical page links',()=>{
 const req=request({offset:'50'}),window=pagination.window(req);assert.deepEqual(window,{size:25,page:3,limit:26,offset:50});
 const {pager}=pagination.fromWindow(req,['a','b'],window);assert.equal(pager.from,51);assert.equal(pager.to,52);assert.equal(pager.previousHref,'/returns?page=2');
});
test('non-aligned retained offsets show the actual row range',()=>{
 const req=request({offset:'3'}),window=pagination.window(req),result=pagination.fromWindow(req,['a','b'],window);
 assert.equal(window.offset,3);assert.equal(result.pager.from,4);assert.equal(result.pager.to,5);
});
test('malformed retained offsets are refused before querying any records',()=>{
 for(const offset of ['-1','1.5','abc','','1000001','9007199254740993',['0','50']])assert.throws(()=>pagination.window(request({offset})),/valid list page/);
});
test('new page selection and remembered row counts retain their behavior',()=>{
 const req=request({page:'2',rows:'50',offset:'75'}),window=pagination.window(req);assert.deepEqual(window,{size:50,page:2,limit:51,offset:50});assert.equal(req.session.listPageSize,50);
 delete req.query.rows;delete req.query.offset;req.query.page='3';assert.equal(pagination.window(req).offset,100);
});
