'use strict';
const {ValidationError}=require('../domain/errors');
function assertInterval(input){
 const interval=String(input||'monthly').trim().toLowerCase();
 if(!['monthly','annual'].includes(interval))throw new ValidationError('Choose monthly or annual billing.');
 return interval.toUpperCase();
}
module.exports={assertInterval,assertMonthly:assertInterval};
