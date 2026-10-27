'use strict';
const fs=require('node:fs'),path=require('node:path'),ejs=require('ejs');let checked=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(file.endsWith('.ejs')){ejs.compile(fs.readFileSync(file,'utf8'),{filename:file});checked++;}}}
walk(path.resolve(__dirname,'../src/web/views'));console.log(checked+' customer templates compiled.');
