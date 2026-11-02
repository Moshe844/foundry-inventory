'use strict';
// An isolated dependency regression server: never mounted by StockChief.
const express=require('express'),crypto=require('node:crypto'),app=express();
app.use((req,res,next)=>{const digest=crypto.createHash('sha256');req.on('data',chunk=>digest.update(chunk));req.once('end',()=>{req.wireHash=digest.digest('hex');});next();});
app.use(express.json({limit:'256kb'}));app.use(express.urlencoded({extended:true,limit:'256kb'}));app.use(express.raw({type:'application/octet-stream',limit:'256kb'}));
app.post('/probe',(req,res)=>{
 if(req.get('x-delayed-tail'))process.send({kind:'parsed',id:req.get('x-delayed-tail')});
 const finish=()=>res.json({pid:process.pid,value:Buffer.isBuffer(req.body)?req.body.toString():req.body.value,wireHash:req.wireHash});
 if(req.readableEnded)finish();else req.once('end',finish);
});
app.get('/health',(req,res)=>res.json({pid:process.pid,ok:true}));
app.use((error,req,res,next)=>res.status(error.status||400).json({error:error.type||'invalid_body'}));
const server=app.listen(0,'127.0.0.1',()=>process.send({kind:'ready',port:server.address().port,pid:process.pid}));
process.on('message',message=>{if(message==='stop'){server.close(()=>process.exit(0));server.closeAllConnections();}});
