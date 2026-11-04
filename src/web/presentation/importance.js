'use strict';
// How much something matters, in one place: its level, its label and its order.
const LEVELS=Object.freeze([{key:'urgent',label:'Urgent'},{key:'important',label:'Important'},{key:'normal',label:'Normal'}]);
function level(item){return item.importance==='Urgent'?LEVELS[0]:item.importance==='Important'?LEVELS[1]:LEVELS[2];}
function rank(item){return LEVELS.indexOf(level(item));}
// Array sort is stable, so items of one level keep their existing order.
function mostImportantFirst(items){return [...items].sort((a,b)=>rank(a)-rank(b));}
function counts(items){return LEVELS.map(entry=>({...entry,count:items.filter(item=>level(item)===entry).length}));}
module.exports={LEVELS,level,rank,mostImportantFirst,counts};
