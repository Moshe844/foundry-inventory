'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { startCluster } = require('../helpers/postgres-cluster');
const { openPostgres } = require('../../src/db/postgres');
const { migratePostgres } = require('../../src/db/migrate-postgres');
const { createPostgresSessionStore } = require('../../src/web/postgres-session-store');
const authMiddleware = require('../../src/web/postgres-auth-middleware');
const commonMiddleware = require('../../src/web/middleware');
const { createPostgresAuthRouter } = require('../../src/web/routes/postgres-auth');

function csrfFrom(html) {
  const token=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if(!token)throw new Error('No CSRF token in response');
  return token;
}

function makeApp(database,connectionString) {
  const app=express();
  app.set('view engine','ejs');
  app.set('views',path.resolve(__dirname,'../../src/web/views'));
  app.use(express.urlencoded({extended:true}));
  const store=createPostgresSessionStore(connectionString,{sweepIntervalMs:86400000});
  app.use(session({name:'foundry.sid',secret:'postgres-http-test-secret',store,resave:false,
    saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:false,maxAge:86400000}}));
  app.use((req,res,next)=>{res.locals.appName='StockChief';res.locals.origin='http://stockchief.test';next();});
  app.use(commonMiddleware.flash);
  app.use(commonMiddleware.csrf);
  app.use(authMiddleware.loadUser(database));
  app.use(createPostgresAuthRouter(database));
  app.get('/onboarding',(req,res)=>res.json({workspaceId:req.ctx?.workspaceId || null}));
  app.get('/whoami',(req,res)=>res.json({accountId:req.ctx?.accountId || null,workspaceId:req.ctx?.workspaceId || null}));
  app.use((error,req,res,next)=>{void next;res.status(error.status || 500).json({error:error.message});});
  return { app,store };
}

test('PostgreSQL browser authentication shares a real tenant session across web instances',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const firstDatabase=openPostgres(cluster.connectionString,{applicationName:'auth-http-first'});
    const secondDatabase=openPostgres(cluster.connectionString,{applicationName:'auth-http-second'});
    await migratePostgres(firstDatabase);
    const first=makeApp(firstDatabase,cluster.connectionString);
    const second=makeApp(secondDatabase,cluster.connectionString);
    context.after(async()=>{
      await Promise.all([first.store.close(),second.store.close()]);
      await Promise.all([firstDatabase.close(),secondDatabase.close()]);
      cluster.stop();
    });
    const agent=request.agent(first.app);
    const registration=await agent.get('/register');
    assert.equal(registration.status,200);
    const registered=await agent.post('/register').type('form').send({
      _csrf:csrfFrom(registration.text),name:'Browser Owner',businessName:'Shared Postgres Inventory',
      email:'browser@example.test',password:'browser-password',
    });
    assert.equal(registered.status,302);
    assert.equal(registered.headers.location,'/onboarding');
    const identity=await agent.get('/whoami');
    assert.ok(identity.body.accountId);
    assert.ok(identity.body.workspaceId);
    const cookie=identity.headers['set-cookie'] || registered.headers['set-cookie'];
    const shared=await request(second.app).get('/whoami').set('Cookie',cookie);
    assert.equal(shared.body.accountId,identity.body.accountId);
    assert.equal(shared.body.workspaceId,identity.body.workspaceId);

    const stranger=request.agent(second.app);
    const login=await stranger.get('/login');
    const bad=await stranger.post('/login').type('form').send({_csrf:csrfFrom(login.text),
      email:'browser@example.test',password:'wrong-password'});
    assert.equal(bad.status,401);
    const good=await stranger.post('/login').type('form').send({_csrf:csrfFrom(login.text),
      email:'browser@example.test',password:'browser-password',next:'/whoami'});
    assert.equal(good.status,302);
    assert.equal(good.headers.location,'/whoami');
  });
