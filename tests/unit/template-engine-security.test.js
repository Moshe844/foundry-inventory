'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),ejs=require('ejs');
test('template rendering ignores inherited data and render options while escaping customer content',()=>{
 const data=Object.assign(Object.create({leaked:'inherited secret',delimiter:'?'}),{name:'<script>bad()</script>',delimiter:'?'});
 assert.equal(ejs.render('<%= name %> / <%= typeof leaked %>',data),'&lt;script&gt;bad()&lt;/script&gt; / undefined');
 assert.equal(ejs.render('<%= name %>',{name:'Safe',client:true,outputFunctionName:'untrusted-option'}),'Safe');
});
