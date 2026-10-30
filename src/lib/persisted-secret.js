'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Publish a complete file atomically. Concurrent first starts must use the
// winner's key, and an invalid existing key must never be silently replaced.
function readOrCreate(file,{create,valid}){
 const read=()=>{const value=fs.readFileSync(file);if(!valid(value))throw new Error('The saved '+path.basename(file)+' is invalid. Restore its original secret before continuing.');return value;};
 try{return read();}catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=file+'.'+crypto.randomUUID()+'.pending';let descriptor;
 try{descriptor=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(descriptor,create());fs.fsyncSync(descriptor);fs.closeSync(descriptor);descriptor=undefined;
  try{fs.linkSync(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;}
  return read();
 }finally{if(descriptor!==undefined)fs.closeSync(descriptor);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
module.exports={readOrCreate};
