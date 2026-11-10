'use strict';
// One answer to "how much stock do we hold", for every page and for Ask.
//
// Products counted in whole units (pieces, pairs, boxes) add into one total of
// units. Products measured in kilograms, metres or litres are never added to
// them (3.75 kg is not 3.75 more pairs): each measured unit keeps its own
// total. Every stock-holding status is included; archiving a product writes its
// stock off, so an archived product normally holds none.
//
// The totals read the per-product, per-location rollup that a trigger keeps
// equal to the stock positions, so a business-wide total reads one row per
// product and location instead of every variant.
const MEASURED='coalesce(i.quantity_precision,0)>0';

// A JSON value {units, measured:[{unit, quantity}]} for one business, or for one
// location of it. The arguments are SQL expressions (a parameter or a column).
function totalsSql(workspace,location=null){
  const where=`r.workspace_id=${workspace}${location?` AND r.location_id=${location}`:''}`;
  return `(SELECT jsonb_build_object('units',coalesce(sum(t.quantity) FILTER(WHERE NOT t.measured),0),
      'measured',coalesce(jsonb_agg(jsonb_build_object('unit',t.unit,'quantity',t.quantity) ORDER BY t.unit) FILTER(WHERE t.measured AND t.quantity<>0),'[]'::jsonb))
    FROM (SELECT ${MEASURED} AS measured,CASE WHEN ${MEASURED} THEN coalesce(nullif(i.unit_label,''),'measured') END AS unit,sum(r.on_hand) AS quantity
      FROM item_location_balances r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id
      WHERE ${where} GROUP BY 1,2) t)`;
}

function read(value){
  const totals=typeof value==='string'?JSON.parse(value):value||{};
  return {units:Number(totals.units)||0,measured:(totals.measured||[]).map(m=>({unit:String(m.unit),quantity:Number(m.quantity)}))};
}

async function forBusiness(database,workspaceId){
  return read((await database.query(`SELECT ${totalsSql('$1')} AS totals`,[workspaceId])).rows[0].totals);
}

// "3.75 kg, 12 m" for the measured part, in the order the totals list them.
function measuredText(measured){
  const qty=new Intl.NumberFormat('en-US',{maximumFractionDigits:6});
  return (measured||[]).map(m=>`${qty.format(m.quantity)} ${m.unit}`).join(', ');
}

module.exports={MEASURED,totalsSql,read,forBusiness,measuredText};
