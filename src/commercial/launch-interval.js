'use strict';
const {ValidationError}=require('../domain/errors');
// Preserve annual webhook/renewal history; sell monthly only at initial launch.
function assertMonthly(input){
 const interval=String(input||'monthly').trim().toLowerCase();
 if(interval!=='monthly')throw new ValidationError('Annual billing is not available for the initial launch. Choose monthly billing.');
 return 'MONTHLY';
}
module.exports={assertMonthly};
