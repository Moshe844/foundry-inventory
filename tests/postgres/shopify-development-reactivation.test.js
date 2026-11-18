'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const csrf=html=>html.match(/name="_csrf" value="([^"]+)"/)?.[1];

test('only a new verified no-charge development cycle can replace a completed test cancellation',
  {timeout:360000},async t=>{
    const environment={...process.env},originalFetch=global.fetch;
    Object.assign(process.env,{SHOPIFY_PARTNER_ID:'5146412',SHOPIFY_PUBLIC_APP_ID:'448446889985',
      SHOPIFY_PARTNER_ACCESS_TOKEN:'fixture-development-token',SHOPIFY_PUBLIC_CLIENT_ID:'fixture-development-client',
      SHOPIFY_PUBLIC_CLIENT_SECRET:'fixture-development-secret'});
    const cluster=await require('../helpers/postgres-cluster').startCluster();
    const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
    let app;
    try{
      await require('../../src/db/migrate-postgres').migratePostgres(db);
      const auth=require('../../src/domain/postgres-auth-service');
      const service=require('../../src/commercial/postgres-shopify-billing');
      const provider=require('../../src/commercial/shopify-billing');
      const entitlements=require('../../src/commercial/entitlements');
      const fixtures=new Map(),calls=[];
      app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
      global.fetch=async(url,options)=>{
        const address=new URL(url),body=JSON.parse(options.body||'{}');
        calls.push(address.hostname);
        assert.equal(address.hostname,'partners.shopify.com','Every provider read must remain a synthetic Shopify fixture');
        const f=fixtures.get(body.variables.shopId||body.variables.filter?.shopId);
        assert(f,'The provider request must identify a fixture store');
        if(body.query===provider.SUBSCRIPTION_QUERY)return Response.json({data:{activeSubscription:f.remote}});
        if(body.query===provider.HISTORY_QUERY)return Response.json({data:{events:{
          pageInfo:{hasNextPage:false,endCursor:null},edges:f.events.map(node=>({node}))}}});
        throw Error('Unexpected provider operation');
      };

      function remote(f,plan,start=Date.now()-60000,{trial=false,paid=!f.owner.developmentStore}={}){
        return {shop:{id:f.owner.shopId,myshopifyDomain:f.owner.shop},billingPeriod:'EVERY_30_DAYS',
          cancelAtEndOfCycle:false,trialEndsAt:trial?new Date(Date.now()+86400000).toISOString():null,
          currentBillingCycle:{startTime:new Date(start).toISOString(),endTime:new Date(start+30*86400000).toISOString()},
          items:[{handle:plan,price:{__typename:'FlatRatePrice',active:paid,currency:'USD',
            amount:paid?(provider.PRICES[plan]/100).toFixed(2):'0.0'}}]};
      }
      async function fixture(plan,{developmentStore=true}={}){
        const n=fixtures.size+1,password='DevelopmentBillingFixture!42';
        let account=await auth.createPendingAccount(db,{name:'Development owner '+n,businessName:'Development billing '+n,
          email:'development-reactivate-'+n+'@example.test',password,planId:plan});
        await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[account.id]);
        account=await auth.getAccount(db,account.id);
        const f={account,password,owner:{appId:'gid://shopify/App/448446889985',shopId:'gid://shopify/Shop/'+n,
          shop:'development-reactivate-'+n+'.myshopify.com',appHandle:'stockchief',developmentStore}};
        f.remote=remote(f,plan);
        f.events=[{id:'created-'+n,eventType:'SUBSCRIPTION_CREATED',occurredAt:f.remote.currentBillingCycle.startTime,
          subject:{id:f.owner.appId},shop:{id:f.owner.shopId,myshopifyDomain:f.owner.shop}}];
        if(!developmentStore)f.events.push({id:'charge-'+n,eventType:'CHARGE_RECURRING',chargeId:'paid-app-charge-'+n,
          planHandle:plan,amount:{amount:(provider.PRICES[plan]/100).toFixed(2),currencyCode:'USD'},
          occurredAt:f.remote.currentBillingCycle.startTime,subject:{id:f.owner.appId},shop:f.remote.shop});
        fixtures.set(f.owner.shopId,f);
        await service.reserve(db,account,f.owner);
        await service.apply(db,account.id,f.owner,f.remote,f.events);
        f.installation={shop:f.owner.shop,client_id:process.env.SHOPIFY_PUBLIC_CLIENT_ID};
        return f;
      }
      const guarantee=async f=>(await db.query('SELECT * FROM commercial_shopify_guarantees WHERE account_id=$1',[f.account.id])).rows[0];
      const support=async id=>(await db.query('SELECT * FROM support_requests WHERE request_key=$1',['shopify-guarantee:'+id])).rows[0];
      async function billingPage(f){
        if(!f.browser){f.browser=request.agent(app);const login=await f.browser.get('/login');
          await f.browser.post('/login').type('form').send({_csrf:csrf(login.text),email:f.account.email,password:f.password});}
        const page=await f.browser.get('/settings/billing');
        assert.equal(page.status,200,page.text);
        return page;
      }
      async function cancel(f){
        const cancelledRemote=structuredClone(f.remote),requested=await service.requestRefund(db,f.account.id);
        f.cancellations=0;
        f.fake={active:async()=>f.remote?provider.contract(f.remote,f.owner):null,
          cancel:async()=>{f.cancellations++;f.remote=null;return {cancelledAt:new Date().toISOString()};},history:async()=>f.events};
        const job={payload:{accountId:f.account.id,requestId:requested.id}};
        const result=await service.processGuarantee(db,job,{provider:f.fake});
        return {requested,job,result,cancelledRemote};
      }
      async function unchanged(f){return {binding:await service.get(db,f.account.id),
        subscription:await entitlements.subscriptionFor(db,f.account.id),request:await guarantee(f)};}

      for(const [plan,nextPlan] of [['starter','growth'],['growth','pro'],['pro','starter']])await t.test(
        plan+' test cancellation can select '+nextPlan+' and activate only its genuinely newer $0 cycle',async()=>{
          const f=await fixture(plan),initial=await service.get(db,f.account.id),deadline=(await service.quote(db,f.account.id)).deadline;
          const cancelled=await cancel(f),oldRequest=await guarantee(f),oldSupport=await support(oldRequest.id);
          assert.equal(cancelled.result.status,'NO_CHARGE');
          assert.equal(oldSupport.status,'RESOLVED');
          assert.equal(entitlements.operationalAccess(await entitlements.subscriptionFor(db,f.account.id)).canOperate,false);
          assert.equal((await service.quote(db,f.account.id)).canChoosePlan,true);
          assert.equal((await service.installationState(db,f.account,f.installation)).canChoosePlan,true);
          assert.equal(await service.startInstallation(db,f.account,f.installation),provider.selectionUrl(f.owner));
          const bill=await billingPage(f);
          assert.match(bill.text,/Manage plan in Shopify/);
          assert.match(bill.text,/choose another development-store test plan/);

          const before=await unchanged(f);
          f.remote=cancelled.cancelledRemote;
          await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),e=>e.code==='shopify_development_plan_pending');
          const state=await service.installationState(db,f.account,f.installation);
          assert.equal(state.canChoosePlan,true);
          assert.equal(state.canOperate,false,'A stale provider response must not revive the cancelled test');
          f.remote=remote(f,nextPlan,new Date(oldRequest.requested_at).getTime());
          await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),e=>e.code==='shopify_development_plan_pending');
          assert.deepEqual(await unchanged(f),before,'Equal timestamps and stale cycles cannot retire cancellation history');

          f.remote=remote(f,nextPlan,new Date(oldRequest.requested_at).getTime()+1);
          await service.reconcile(db,f.account.id);
          assert.equal(await guarantee(f),undefined);
          const active=await entitlements.subscriptionFor(db,f.account.id);
          assert.equal(active.plan_id,nextPlan);
          assert.equal(active.source,'SHOPIFY');
          assert.equal(active.stripe_subscription_id,null);
          assert.equal(entitlements.operationalAccess(active).canOperate,true);
          const binding=await service.get(db,f.account.id);
          assert.equal(binding.first_subscription_at.toISOString(),initial.first_subscription_at.toISOString());
          assert.equal((await service.quote(db,f.account.id)).deadline.toISOString(),deadline.toISOString(),'A new free test cannot reset the original guarantee window');
          const audit=await support(oldRequest.id);
          assert.equal(audit.id,oldSupport.id);
          assert.equal(audit.status,'RESOLVED');
          assert(audit.body.startsWith(oldSupport.body));
          assert.match(audit.body,/Retired no-charge development cancellation/);
          assert(audit.body.includes(oldRequest.id));
          assert(audit.body.includes('"newPlanId":"'+nextPlan+'"'));
          await service.reconcile(db,f.account.id);
          assert.equal((await support(oldRequest.id)).body,audit.body,'Repeated reconciliation does not duplicate the retired audit');
          assert.equal((await service.processGuarantee(db,cancelled.job,{provider:f.fake})).replayed,true);
          assert.equal(f.cancellations,1,'A delayed old refund job must not cancel the new development subscription');
        });

      await t.test('pending cancellations retain their selection and activation guards',async()=>{
        const f=await fixture('growth'),saved=await service.requestRefund(db,f.account.id);
        f.remote=remote(f,'pro',new Date(saved.requested_at).getTime()+1);
        for(const status of ['REQUESTED','AWAITING_SHOPIFY','PARTIAL','REVIEW']){
          await db.query('UPDATE commercial_shopify_guarantees SET status=$2 WHERE id=$1',[saved.id,status]);
          const before=await unchanged(f);
          assert.equal((await service.quote(db,f.account.id)).canChoosePlan,false);
          await assert.rejects(service.startInstallation(db,f.account,f.installation),/refund request is being handled/);
          await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),/cancellation and refund request is being handled/);
          assert.deepEqual(await unchanged(f),before);
          assert.doesNotMatch((await billingPage(f)).text,/Manage plan in Shopify/);
        }
      });

      await t.test('a real-money refunded subscription stays blocked even with a forged development owner',async()=>{
        const f=await fixture('growth',{developmentStore:false}),cancelled=await cancel(f);
        assert.equal(cancelled.result.status,'AWAITING_SHOPIFY');
        const charge=f.events.find(event=>event.eventType==='CHARGE_RECURRING');
        f.events.push({id:'refund-'+f.owner.shopId,eventType:'EARNING_REFUND',earningChargeId:charge.chargeId,
          grossAmount:charge.amount,occurredAt:new Date().toISOString(),subject:{id:f.owner.appId},shop:charge.shop});
        assert.equal((await service.processGuarantee(db,cancelled.job,{provider:f.fake})).status,'REFUNDED');
        const before=await unchanged(f),audit=await support(cancelled.requested.id);
        f.remote=remote(f,'pro',new Date(cancelled.requested.requested_at).getTime()+1,{paid:false});
        await assert.rejects(service.startInstallation(db,f.account,f.installation),/refund request is being handled/);
        await assert.rejects(service.apply(db,f.account.id,{...f.owner,developmentStore:true},f.remote,f.events),/cancellation and refund request is being handled/);
        assert.equal((await service.quote(db,f.account.id)).canChoosePlan,false);
        assert.doesNotMatch((await billingPage(f)).text,/Manage plan in Shopify/);
        assert.deepEqual(await unchanged(f),before);
        assert.deepEqual(await support(cancelled.requested.id),audit);
      });

      await t.test('zero-charge recovery rejects stale trials, paid prices, positive history and missing resolved audit',async()=>{
        const f=await fixture('starter'),cancelled=await cancel(f),saved=await guarantee(f),start=new Date(saved.requested_at).getTime()+1;
        const before=await unchanged(f),audit=await support(saved.id);
        f.remote=remote(f,'growth',new Date(saved.requested_at).getTime()-60000,{trial:true});
        await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),e=>e.code==='shopify_development_plan_pending');
        f.remote=remote(f,'growth',start,{paid:true});
        await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),/cancellation and refund request is being handled/);
        f.remote=remote(f,'growth',start);
        const charged=[...f.events,{id:'unexpected-paid-charge',eventType:'CHARGE_RECURRING',chargeId:'unexpected-paid',planHandle:'growth',
          amount:{amount:'499.00',currencyCode:'USD'},occurredAt:new Date().toISOString(),subject:{id:f.owner.appId},shop:f.remote.shop}];
        await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,charged),/cancellation and refund request is being handled/);
        assert.deepEqual(await unchanged(f),before);
        assert.deepEqual(await support(saved.id),audit);
        await db.query("UPDATE support_requests SET status='IN_REVIEW' WHERE id=$1",[audit.id]);
        await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),/resolved support record/);
        assert.deepEqual(await unchanged(f),before,'Without durable resolved audit the guarantee and cancelled subscription must remain intact');
        await db.query("UPDATE support_requests SET status='RESOLVED' WHERE id=$1",[audit.id]);
        await db.query('UPDATE commercial_shopify_subscriptions SET development_store=false WHERE account_id=$1',[f.account.id]);
        await assert.rejects(service.startInstallation(db,f.account,f.installation),/refund request is being handled/);
        await assert.rejects(service.apply(db,f.account.id,f.owner,f.remote,f.events),/cancellation and refund request is being handled/);
        assert.equal((await guarantee(f)).id,cancelled.requested.id,'An owner argument cannot replace persisted development-store identity');
      });
      assert(calls.length>0);
      assert(calls.every(host=>host==='partners.shopify.com'),'No development cancellation or reactivation path can call Stripe');
    }finally{
      global.fetch=originalFetch;
      if(app)await app.locals.sessionStore.close();
      await db.close();await cluster.stop();process.env=environment;
    }
  });
