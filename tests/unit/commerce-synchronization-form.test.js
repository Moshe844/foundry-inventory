'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
test('sync form is owner-only, binds the current inventory/connection and prepares rather than executes',async t=>{
 const connections=require('../../src/connections/postgres-service'),workflows=require('../../src/assistant/postgres-workflow-capabilities');
 let prepares=0,reads=0;
 t.mock.method(connections,'get',async(db,workspace,id)=>{reads++;assert.equal(workspace,'inventory');if(id!=='own')throw new Error('Connection not found');return {id,provider_type:'bigcommerce',display_name:'Fixture'};});
 t.mock.method(workflows,'prepare',async(db,ctx,message,capability,args)=>{prepares++;assert.equal(ctx.workspaceId,'inventory');assert.equal(capability,'connection.commerce_sync');assert.deepEqual(args,{recordReference:'own',sku:'SKU-1',location:'Warehouse',initialSyncSource:'require_equal',quantitySyncMode:'outbound'});return {proposal:{id:'review-fixture'}};});
 const app=express();app.use(express.urlencoded({extended:false}));app.use((req,res,next)=>{req.user={role:req.get('x-fixture-role')||'owner'};req.ctx={workspaceId:'inventory',actorId:'owner'};next();});
 app.use(require('../../src/web/routes/postgres-connections').createPostgresConnectionsRouter({}, {providers:{catalog:()=>[]}}));
 app.use((error,req,res,next)=>res.status(400).json({error:error.message}));
 const body={sku:'SKU-1',location:'Warehouse',initialSyncSource:'require_equal',quantitySyncMode:'outbound',priceSyncMode:'',workspaceId:'foreign',recordReference:'foreign',connectorId:'foreign'};
 await request(app).post('/settings/connections/own/commerce-synchronization').set('x-fixture-role','member').type('form').send(body).expect(400);assert.equal(reads,0);assert.equal(prepares,0);
 await request(app).post('/settings/connections/foreign/commerce-synchronization').type('form').send(body).expect(400);assert.equal(prepares,0);
 await request(app).post('/settings/connections/own/commerce-synchronization').type('form').send(body).expect(303).expect('Location','/actions/review-fixture');assert.equal(prepares,1);
});
test('installed BigCommerce landing keeps the control-panel frame and exposes guide/support',()=>{
 const ejs=require('ejs'),fs=require('node:fs'),path=require('node:path');
 const template=fs.readFileSync(path.join(__dirname,'../../src/web/views/connections/provider-handoff.ejs'),'utf8');
 const installed=ejs.render(template,{installed:true,continueUrl:'/settings/connections'});
 assert.match(installed,/target="_blank" rel="noopener noreferrer" href="\/settings\/connections"/);
 assert.doesNotMatch(installed,/data-provider-handoff|src="\/provider-handoff.js"/);
 assert.match(installed,/Installation and user guide/);assert.match(installed,/mailto:support@stockchiefhq.com/);
 const installing=ejs.render(template,{continueUrl:'/settings/connections/bigcommerce/callback?handoff=1'});
 assert.match(installing,/data-provider-handoff/);assert.match(installing,/target="_top"/);
});
test('sync approval shows business quantities and currency without internal IDs or integrity hashes',()=>{
 const result=require('../../src/web/proposal-presentation').present({action_type:'connection.commerce_sync',payload:{sku:'DEMO',location:'Dispatch',source:'stockchief',integrity:'internal-hash',positions:[{field:'price',mode:'outbound',sku_id:'private-id',local:{value:{amount:1250,currency:'USD'}},remote:{value:{amount:1300,currency:'USD'}}},{field:'quantity',mode:'off',local:{value:0,physical:2,costed:0},remote:{value:null}}]}});
 const text=JSON.stringify(result);assert.match(text,/StockChief to provider/);assert.match(text,/12\.50/);assert.match(text,/13\.00/);assert.match(text,/Physical stock/);assert.match(text,/Not checked/);assert.doesNotMatch(text,/internal-hash|private-id|1250|sku_id/);
});
