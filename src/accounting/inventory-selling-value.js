'use strict';

// Read-only selling-value evidence. Latest recorded prices, not supplied-fact
// guesses or replacement costs. Aggregate before limiting supporting records.
const SOURCE = `WITH priced AS (
 SELECT i.name product,s.code sku,l.name location,b.on_hand units,
   sp.amount_minor price_minor,sp.currency,
   CASE WHEN sp.amount_minor IS NOT NULL THEN b.on_hand*sp.amount_minor ELSE NULL END value_minor
 FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=@w AND s.is_active=1
 JOIN items i ON i.id=s.item_id AND i.workspace_id=@w AND i.is_active=1
 JOIN locations l ON l.id=b.location_id AND l.workspace_id=@w
 LEFT JOIN sku_prices sp ON sp.rowid=(SELECT p.rowid FROM sku_prices p
   WHERE p.workspace_id=@w AND p.sku_id=s.id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 1)
 WHERE b.workspace_id=@w AND b.on_hand>0)`;
function execute(db,workspaceId){
 const params={w:workspaceId};
 const totals=db.prepare(`${SOURCE} SELECT COUNT(*) positions,COALESCE(SUM(units),0) units,
   COALESCE(SUM(CASE WHEN price_minor IS NULL THEN units ELSE 0 END),0) unpriced_units FROM priced`).get(params);
 const currencies=db.prepare(`${SOURCE} SELECT currency,SUM(units) units,SUM(value_minor) value_minor
   FROM priced WHERE price_minor IS NOT NULL GROUP BY currency ORDER BY currency`).all(params);
 const money=(value,currency)=>new Intl.NumberFormat('en-US',{style:'currency',currency}).format(value/100);
 const evidence=db.prepare(`${SOURCE} SELECT * FROM priced ORDER BY product,sku,location LIMIT 25`).all(params);
 const rows=evidence.map(r=>({product:r.product,sku:r.sku,location:r.location,units:r.units,
   sellingPrice:r.price_minor===null?'Not recorded':money(r.price_minor,r.currency),
   sellingValue:r.value_minor===null?'Not recorded':money(r.value_minor,r.currency)}));
 const amounts=currencies.map(r=>`${money(r.value_minor,r.currency)} (${r.currency}, ${r.units.toLocaleString('en-US')} priced units)`).join('; ');
 let answer=currencies.length?`Current stock at recorded selling prices: ${amounts}.`:
  totals.units?'Current stock has no recorded selling-price evidence; I cannot calculate its selling value.':'There are no positive on-hand units to value.';
 if(totals.unpriced_units>0)answer+=` ${totals.unpriced_units.toLocaleString('en-US')} of ${totals.units.toLocaleString('en-US')} on-hand units have no recorded selling price. This is not a complete selling value; missing prices are not zero.`;
 if(currencies.length>1)answer+=' Currencies are reported separately; no exchange rate was assumed.';
 const negative=db.prepare('SELECT COUNT(*) n FROM balances WHERE workspace_id=? AND on_hand<0').get(workspaceId).n;
 if(negative)answer+=` ${negative} negative stock balances are excluded from positive on-hand value and need separate review.`;
 answer+=' This is catalogue selling value, not cost value or realized sales revenue.';
 return {answer,rows,columns:['product','sku','location','units','sellingPrice','sellingValue'],answerMode:'verified',
  handoff:{href:'/accounting',label:'Open inventory economics'}};
}
module.exports={execute};
