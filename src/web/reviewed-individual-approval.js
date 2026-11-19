'use strict';
const approval=require('../commercial/individual-approval');

// Only a deliberate decision about a saved record can enter this context.
// Run/check/prepare endpoints, settings, teaching, groups and whole missions
// never receive it. Existing handlers still enforce CSRF, role, plan, exact
// source fingerprints, confirmation, amount limits and replay protections.
function reviewedRecordPath(path){
 if(!/^\/autopilot\/(?:[A-Za-z0-9_-]+\/){2,5}(?:approve|apply|review|send|confirm|accept)$/.test(path))return false;
 const parts=path.split('/'),family=parts[2]==='reviews'?parts[3]:parts[2];
 return !/group|mission|playbook|routine|rule|mode|shadow|api/i.test(family);
}
function middleware(req,res,next){
 if(req.method!=='POST'||!req.ctx?.workspaceId||!req.ctx?.actorId||!reviewedRecordPath(req.path))return next();
 return approval.run(req.ctx,next);
}
module.exports={middleware,reviewedRecordPath};
