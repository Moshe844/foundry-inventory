'use strict';
const {asyncRoute}=require('./middleware');
module.exports=db=>asyncRoute(async(req,res,next)=>{
 if(!req.account)return next();const state=await require('../domain/postgres-mfa').state(db,req.account.id,req.ctx?.workspaceId);req.mfaState=state;
 const security=req.path==='/settings/security'||req.path.startsWith('/settings/security/'),challenge=req.path==='/auth/mfa';
 if(security||challenge||req.path==='/logout')return next();
 if(state.enabled&&Number(req.session.mfaRevision)!==Number(state.revision)||state.required&&!state.enabled){
  const href=state.enabled?'/auth/mfa':'/settings/security';
  if(!req.accepts('html'))return res.status(403).json({error:{code:'mfa_required',message:state.enabled?'Verify your authenticator code to continue.':'Your business requires two-step sign-in. Set up your authenticator to continue.',href}});
  return res.redirect(303,href);
 }return next();
});
