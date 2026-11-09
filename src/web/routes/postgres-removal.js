'use strict';
// Delete any supported record: a review page that says exactly what will
// happen (erase, or archive with history kept), then the deletion itself.
const express=require('express'),{requireAuth,asyncRoute}=require('../middleware');
const removal=require('../../domain/postgres-record-removal');

function createPostgresRemovalRouter(database){
 const router=express.Router();
 const show=async(req,res,error=null)=>{
  const review=await removal.review(database,req.ctx,req.user,req.params.kind,req.params.id);
  const currency=(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])).rows[0]?.base_currency||'USD';
  return res.status(error?400:200).page('removal/review',{title:'Delete '+review.noun,nav:{customer:'sales',supplier:'purchasing',product:'inventory',import:'imports'}[review.kind],review,currency,error});
 };
 router.get('/delete/:kind/:id',requireAuth,asyncRoute((req,res)=>show(req,res)));
 router.post('/delete/:kind/:id',requireAuth,asyncRoute(async(req,res)=>{
  let done;
  try{done=await removal.remove(database,req.ctx,req.user,req.params.kind,req.params.id,{expectedHash:String(req.body.reviewHash||'')});}
  catch(error){if(!error.status||error.status>=500||error.status===403||error.status===404)throw error;return show(req,res,error.message);}
  if(done.outcome==='running')return res.redirect(303,'/delete/import/'+encodeURIComponent(req.params.id));
  const name=done.name;
  req.flash('success',done.outcome==='erased'?`${name} was deleted.`:done.outcome==='removed'?`${name} was deleted.`
   :`${name} was deleted from your lists. Its past records stay in your history${done.removed?.positions?', and its remaining stock was written off':''}.`);
  return res.redirect(303,done.list);
 }));
 return router;
}
module.exports={createPostgresRemovalRouter};
