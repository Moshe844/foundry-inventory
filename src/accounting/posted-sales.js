'use strict';
// "Sales this period" has one meaning everywhere: revenue posted to the books,
// over the business's own calendar. Orders, Money and Reports all read this.
const reports=require('./postgres-reports'),clock=require('../lib/business-time');
async function forPeriod(db,workspaceId,period){const pnl=await reports.profitAndLoss(db,workspaceId,period);return {from:pnl.from,to:pnl.to,minor:pnl.revenueMinor,currency:pnl.currency};}
async function thisMonth(db,workspaceId){const today=(await clock.forWorkspace(db,workspaceId)).calendarDate;return forPeriod(db,workspaceId,{from:today.slice(0,7)+'-01',to:today});}
module.exports={forPeriod,thisMonth};
