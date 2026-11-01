'use strict';
const express=require('express'),mfa=require('../../domain/postgres-mfa'),{requireAccount,requireOwner,asyncRoute}=require('../middleware'),{AuthorizationError}=require('../../domain/errors');
function save(req,method='save'){return new Promise((resolve,reject)=>req.session[method](error=>error?reject(error):resolve()));}
async function password(db,req){const account=await require('../../domain/postgres-auth-service').authenticate(db,req.account.email,req.body.currentPassword,{ip:req.ip});if(account?.id!==req.account.id)throw new AuthorizationError('Enter your current password to confirm this security change.');}
async function stamp(req,revision){const values={accountId:req.session.accountId,workspaceId:req.session.workspaceId,accountAccessRevision:req.session.accountAccessRevision,sso:req.session.sso};await save(req,'regenerate');Object.assign(req.session,values,{mfaRevision:revision,csrfToken:require('crypto').randomBytes(24).toString('base64url')});await save(req);}
function createRouter(db){const router=express.Router();
 const render=async(req,res,mode,values={})=>{res.set('Cache-Control','no-store');const notices=(req.session.flash||[]).filter(m=>!m.scope||m.scope===req.path);req.session.flash=(req.session.flash||[]).filter(m=>m.scope&&m.scope!==req.path);return res.render('auth/mfa',{title:'Two-step sign-in',mode,state:await mfa.state(db,req.account.id,req.ctx?.workspaceId),owner:req.user?.role==='owner',csrfToken:res.locals.csrfToken,flash:notices,account:req.account,...values});};
 const ctx=req=>({...req.ctx,accountId:req.account.id});
 router.get('/settings/security',requireAccount,asyncRoute(async(req,res)=>render(req,res,'settings')));
 router.get('/auth/mfa',requireAccount,asyncRoute(async(req,res)=>{if(!req.mfaState.enabled)return res.redirect(303,'/settings/security');return render(req,res,'challenge');}));
 router.post('/settings/security/setup',requireAccount,asyncRoute(async(req,res)=>{await password(db,req);const setup=await mfa.begin(db,ctx(req));return render(req,res,'setup',setup);}));
 router.post('/settings/security/confirm',requireAccount,asyncRoute(async(req,res)=>{const result=await mfa.check(db,ctx(req),req.body.code,{enroll:true});await stamp(req,result.revision);res.locals.csrfToken=require('../middleware').scopedCsrfToken(req.session);return render(req,res,'recovery',{recoveryCodes:result.recoveryCodes});}));
 router.post('/auth/mfa',requireAccount,asyncRoute(async(req,res)=>{const result=await mfa.check(db,ctx(req),req.body.code);await stamp(req,result.revision);return res.redirect(303,'/');}));
 router.post('/settings/security/disable',requireAccount,asyncRoute(async(req,res)=>{await password(db,req);await mfa.check(db,ctx(req),req.body.code);await mfa.disable(db,ctx(req));await stamp(req,0);req.flash('success','Two-step sign-in is disabled.');return res.redirect(303,'/settings/security');}));
 router.post('/settings/security/team',requireAccount,requireOwner,asyncRoute(async(req,res)=>{await password(db,req);if(req.mfaState.enabled&&Number(req.session.mfaRevision)!==Number(req.mfaState.revision))throw new AuthorizationError('Verify your authenticator code first.');await mfa.setPolicy(db,ctx(req),req.body.required==='1');req.flash('success','Your team sign-in requirement was saved.');return res.redirect(303,'/settings/security');}));
 return router;
}
module.exports={createRouter};
