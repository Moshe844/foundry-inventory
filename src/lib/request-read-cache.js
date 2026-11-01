'use strict';
const {AsyncLocalStorage}=require('node:async_hooks'),storage=new AsyncLocalStorage();
function run(operation){return storage.run(new Map(),operation);}
function read(key,operation){const cache=storage.getStore();if(!cache)return operation();if(!cache.has(key)){const result=Promise.resolve().then(operation).catch(error=>{cache.delete(key);throw error;});cache.set(key,result);}return cache.get(key);}
function middleware(req,res,next){return ['GET','HEAD'].includes(req.method)?run(next):next();}
module.exports={run,read,middleware};
