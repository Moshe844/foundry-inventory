'use strict';
// Execution-contract semantics, not intent matching or environment discovery.
// Only these existing readers implement date-scoped canonical queries. All
// other readers must reject an explicit period instead of silently ignoring it.
const periods=Object.freeze(['all_time','today','month_to_date','previous_month','last_30_days']);
function supported(view){
 if(['sales_activity','payments','accounting'].includes(view))return [...periods];
 if(view==='business_analysis')return ['all_time','month_to_date'];
 return ['all_time'];
}
function accepted({view,search,timeframe}){
 if(!timeframe||timeframe==='all_time')return true;
 if(view==='accounting'&&['profit_and_loss','profit_change'].includes(search))return timeframe==='month_to_date';
 return supported(view).includes(timeframe);
}
module.exports={supported,accepted};
