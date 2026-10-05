'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const storage=new AsyncLocalStorage();
module.exports={current:()=>storage.getStore(),run:(context,operation)=>storage.run(context,operation)};
