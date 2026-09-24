'use strict';

const express=require('express');
const searchService=require('../../domain/postgres-search-service');
const {requireAuth,asyncRoute}=require('../middleware');

function createPostgresSearchRouter(database){
  const router=express.Router();
  router.get('/search',requireAuth,asyncRoute(async(req,res)=>{
    const term=String(req.query.q||'').trim();const result=term?await searchService.search(database,req.ctx.workspaceId,term,{limit:25}):{results:[]};
    return res.page('search',{title:term?`Search · ${term}`:'Search',nav:'inventory',searchTerm:term,results:result.results});
  }));
  router.get('/api/search',requireAuth,asyncRoute(async(req,res)=>{
    const term=String(req.query.q||'').trim();if(term.length<2)return res.json({results:[]});
    const result=await searchService.search(database,req.ctx.workspaceId,term,{limit:8});
    return res.json({results:result.results.map(({type,typeLabel,title,subtitle,meta,href})=>({type,typeLabel,title,subtitle,meta,href}))});
  }));
  return router;
}

module.exports={createPostgresSearchRouter};
