'use strict';
const fields=require('./fields');
// OCR spaces are not column boundaries. Join adjacent header fragments only
// when the shared field vocabulary identifies one heading more confidently.
function merge(cells){
 const result=cells.map(c=>({...c}));
 for(let i=0;i<result.length-1;){
  const left=fields.bestFieldScores(result[i].text)[0],right=fields.bestFieldScores(result[i+1].text)[0],
    text=result[i].text+' '+result[i+1].text,joint=fields.bestFieldScores(text)[0];
  const nearby=!Number.isFinite(result[i+1].x)||!Number.isFinite(result[i].right)||result[i+1].x-result[i].right<=3*Math.max(result[i].height||0,result[i+1].height||0);
  if(nearby&&joint&&(left?.field===right?.field||joint.score>=.8&&(!left||left.weak)&&(!right||right.weak))){
   result.splice(i,2,{...result[i],text,right:result[i+1].right});if(i)i--;else i=0;
  }else i++;
 }
 return result;
}
module.exports={merge};
