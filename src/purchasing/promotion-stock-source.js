'use strict';
const calc=require('./promotion-stock-calculation'),{hash}=require('../pricing/postgres-promotions'),{ValidationError}=require('../domain/errors'),{owner,inventoryFacts}=require('./planning-stock-source');
async function readFacts(db,ctx,raw){
 const scope=calc.input(raw),base=await inventoryFacts(db,ctx,scope,{jobId:145,incomingBy:scope.arrivalDate});
 const calculated=calc.calculate(scope,base.today,base.rows),warnings=[...base.warnings],money=require('../domain/currency');
 if(scope.arrivalDate<base.today)warnings.push({reason:'The planned arrival date has passed. Check a current supplier delivery arrangement before preparing a purchase.'});
 if(calculated.deadlinePassed)warnings.push({reason:'The last order date has passed. Confirm new order and delivery dates before preparing a purchase.'});
 if(base.supplier.minimum_order_amount!=null&&calculated.rows.some(r=>r.quantityUnits>0)&&calculated.totalMinor<money.toMinor(String(base.supplier.minimum_order_amount),base.supplier.currency))warnings.push({reason:'The proposed goods total is below the supplier minimum. Review the arrangement separately.'});
 const core={...base,calculated,warnings};return {...core,sourceFingerprint:hash(core)};
}
async function facts(db,ctx,raw){return typeof db.transaction==='function'?db.transaction(c=>readFacts(c,ctx,raw),{isolation:'REPEATABLE READ',retrySafe:true}):readFacts(db,ctx,raw);}
module.exports={facts,owner};
