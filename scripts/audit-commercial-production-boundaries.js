'use strict';
// A deliberately conservative static audit of the PostgreSQL app and worker
// dependency graph. New direct provider/model call sites fail the regression
// until classified; dynamic requires and HTTP destinations still need review.
const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..','src');
const entries=['postgres-app.js','postgres-worker-server.js','operations/postgres-runtime-handlers.js'];
const patterns={model:/\b(?:provider|metered)\.complete\s*\(|\.messages\.create\s*\(/g,
 http:/\bproviderFetch\s*\(|(?:^|[^.\w])fetch\s*\(|\(options\.fetch\s*\|\|\s*fetch\)\s*\(|\b(?:globalThis\.fetch|https?\.request|axios\.[a-z]+)\s*\(/gm};
function resolve(from,relative){const base=path.resolve(path.dirname(from),relative);
 for(const candidate of [base,`${base}.js`,path.join(base,'index.js')])
  if(fs.existsSync(candidate)&&fs.statSync(candidate).isFile()&&candidate.endsWith('.js')&&candidate.startsWith(root+path.sep))return candidate;
 return null;}
function scan(){const pending=entries.map(name=>path.join(root,name));const seen=new Set();const boundaries=[];
 while(pending.length){const file=pending.pop();if(seen.has(file))continue;seen.add(file);
  const source=fs.readFileSync(file,'utf8');const required=/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for(const match of source.matchAll(required)){const dependency=resolve(file,match[1]);if(dependency)pending.push(dependency);}
  for(const [kind,pattern] of Object.entries(patterns)){
   pattern.lastIndex=0;for(const match of source.matchAll(pattern)){
    const line=source.slice(0,match.index).split('\n').length;
    boundaries.push({file:path.relative(root,file).replaceAll('\\','/'),line,kind,expression:match[0].trim()});
   }
  }
 }
 return {files:seen.size,boundaries:boundaries.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line)};
}
if(require.main===module)process.stdout.write(JSON.stringify(scan(),null,2)+'\n');
module.exports={scan};
