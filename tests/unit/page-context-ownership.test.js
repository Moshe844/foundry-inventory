'use strict';const test=require('node:test'),assert=require('node:assert/strict'),context=require('../../src/assistant/postgres-page-context');
test('owned record subpages keep context while foreign IDs cannot become page hints',async()=>{
 const id='item_abcdefghijklmnop',db={query:async(sql,args)=>({rows:args[0]==='owned'&&args[1]===id?[{id,name:'Archived component',code:'C-8'}]:[]})};
 assert.deepEqual(await context.load(db,'owned','/inventory/'+id+'/costs?view=history'),{path:'/inventory/'+id+'/costs?view=history',product:'Archived component',sku:'C-8',recordReference:'Archived component'});
 assert.equal(await context.load(db,'other','/inventory/'+id),null);assert.equal(await context.load(db,'other','/inventory/'+id+'/costs'),null);
 for(const path of ['/inventory/new','/inventory/table?sort=name','/unfamiliar/forms?view=compact'])assert.deepEqual(await context.load(db,'owned',path),{path});
 assert.equal(await context.load(db,'owned','https://elsewhere.invalid/inventory/'+id),null);
});
