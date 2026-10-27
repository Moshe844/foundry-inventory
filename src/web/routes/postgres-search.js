'use strict';

const express=require('express');
const searchService=require('../../domain/postgres-search-service');
const {requireAuth,asyncRoute}=require('../middleware');
const pages=require('../presentation/search-pages'),P=require('../../actions/permissions');
function visible(result,actor){const required={purchase_order:P.VIEW_PURCHASING,supplier:P.VIEW_PURCHASING,sales_order:P.VIEW_SALES,customer:P.VIEW_SALES};result.results=result.results.filter(row=>actor&&P.can(actor,required[row.type]||P.VIEW));return result;}
async function actorFor(db,ctx){return (await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];}

function createPostgresSearchRouter(database){
  const router=express.Router();
  router.get('/search',requireAuth,asyncRoute(async(req,res)=>{
    const term=String(req.query.q||'').trim(),actor=await actorFor(database,req.ctx);const result=term?await searchService.search(database,req.ctx.workspaceId,term,{limit:100}):{results:[]};visible(result,actor);if(!result.exactSku)result.results=[...pages.search(term,{actor,limit:25}),...result.results];
    return res.page('search',{title:term?`Search · ${term}`:'Search',nav:'inventory',searchTerm:term,results:result.results});
  }));
  router.get('/api/search',requireAuth,asyncRoute(async(req,res)=>{
    const term=String(req.query.q||'').trim();if(term.length<2)return res.json({results:[]});
    const actor=await actorFor(database,req.ctx),result=await searchService.search(database,req.ctx.workspaceId,term,{limit:100,groupLimit:8});visible(result,actor);if(!result.exactSku)result.results=[...pages.search(term,{actor}),...result.results];
    return res.json({results:result.results.map(({type,typeLabel,title,subtitle,meta,href})=>({type,typeLabel,title,subtitle,meta,href}))});
  }));
  return router;
}

module.exports={createPostgresSearchRouter};
