'use strict';
async function state(database,{provider=null}={}){
 const pool=require('../commercial/staging-certification-budget'),fundingId=pool.fundingWorkspaceId();
 if(fundingId){const funding=await pool.status(database,fundingId);if(!funding?.active||funding.remaining<=0||funding.unresolved)return {available:false,message:'AI report building is paused on this staging installation. Use a report template or the manual builder below. No AI credits will be used.'};}
 if(!provider?.complete&&!require('../config').ai.configured)return {available:false,message:'AI report building is unavailable right now. Use a report template or the manual builder below. No AI credits will be used.'};
 return {available:true,message:null};
}
module.exports={state};
