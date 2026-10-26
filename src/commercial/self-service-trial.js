'use strict';
const {ValidationError}=require('../domain/errors');
// Kept as a compatibility boundary: no environment flag may create free access.
function policy(){return {enabled:false,days:0,planId:null};}
async function activate(){throw new ValidationError('Choose a paid plan and complete secure checkout to activate your inventory. Every new subscription includes a 14-day money-back guarantee.');}
module.exports={policy,activate};
