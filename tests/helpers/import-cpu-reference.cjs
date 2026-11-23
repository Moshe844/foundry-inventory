'use strict';
// A benchmark-only reference for the two changed CPU paths. Both runs retain
// identical COPY transport, database schema, sources and proofs. The harness
// records the selected session count explicitly for each side.
// Load the reviewed repository version in a fresh process; never patch a live
// application's module cache or accept an arbitrary source path/commit.
if(process.env.NODE_ENV!=='test'||process.env.STOCKCHIEF_COPY_BENCHMARK!=='1')throw new Error('Import CPU reference is restricted to disposable benchmark fixtures.');
const Module=require('node:module'),path=require('node:path'),{execFileSync}=require('node:child_process');
const commit='6f578146aefd1d6746eb25560ea264ef116af580',root=path.resolve(__dirname,'../..');
const sources=new Map(['src/domain/exact-quantity.js','src/imports/postgres-service.js'].map(file=>[
 path.join(root,file),execFileSync('git',['show',commit+':'+file],{cwd:root,encoding:'utf8',maxBuffer:1024*1024,windowsHide:true}),
]));
const original=Module._extensions['.js'];
const evidence=process[Symbol.for('stockchief.importCpuReference')]={commit,loadedFiles:new Set()};
Module._extensions['.js']=(module,filename)=>{
 if(!sources.has(filename))return original(module,filename);
 evidence.loadedFiles.add(path.relative(root,filename).split(path.sep).join('/'));
 return module._compile(sources.get(filename),filename);
};
