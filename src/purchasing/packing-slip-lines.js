'use strict';

const {ValidationError}=require('../domain/errors');
const {matchLine}=require('./supplier-line-match');
const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const money=require('../domain/currency');

function columnKey(name){
  return String(name||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

function sourceColumns(columns){
  const order=new Set(['po','ponumber','poref','purchaseorder','purchaseordernumber','purchaseorderref']);
  const line=new Set(['poline','polinenumber','purchaseorderline','purchaseorderlinenumber','lineno','linenumber']);
  const weights=[];
  const weightUnits=[];
  for(const column of columns){
    const key=columnKey(column.name);
    if(['weightunit','weightuom','actualweightunit','receivedweightunit','netweightunit'].includes(key)){
      weightUnits.push(column);
      continue;
    }
    const measure=/^(?:(?:actual|received|net|total|measured)\s+)?weight(?:\s*\(([^()]+)\)|\s*\[([^\[\]]+)\]|\s+([A-Za-z]+))?$/i.exec(String(column.name).trim());
    if(measure)weights.push({...column,unit:measure[1]||measure[2]||measure[3]||null});
  }
  return {order:columns.filter(c=>order.has(columnKey(c.name))),line:columns.filter(c=>line.has(columnKey(c.name))),weights,weightUnits};
}

function cell(row,column,transforms){
  return String(transforms.imageCellOverrides?.[row.row_number]?.[column.index]??row.raw[column.index]??'').trim();
}

function unit(value){
  const text=String(value||'').trim().toLowerCase();
  if(['kg','kgs','kilogram','kilograms'].includes(text))return 'kg';
  if(['lb','lbs','pound','pounds'].includes(text))return 'lb';
  if(['g','gram','grams'].includes(text))return 'g';
  if(['oz','ounce','ounces'].includes(text))return 'oz';
  if(text==='boxes')return 'box';
  if(['cases','cartons','packs','bundles','pallets','pieces','units'].includes(text))return text.slice(0,-1);
  return text;
}

function actualWeight(row,line,columns,transforms){
  if(!line.secondary_unit_label)return null;
  const statedUnits=columns.weightUnits.map(column=>cell(row,column,transforms)).filter(Boolean);
  const amounts=[];
  for(const column of columns.weights){
    const value=cell(row,column,transforms);
    if(!value)continue;
    const match=/^(\d+(?:[.,]\d+)?)(?:\s*([A-Za-z]+))?$/.exec(value);
    const units=[...statedUnits,column.unit,match?.[2]].filter(Boolean);
    if(!match||!units.length||units.some(value=>unit(value)!==unit(line.secondary_unit_label)))
      throw new ValidationError(line.code+' needs an original actual weight in '+line.secondary_unit_label+' on source row '+row.row_number+'.');
    if(/^[1-9]\d{0,2},\d{3}$/.test(match[1]))
      throw new ValidationError('The weight on source row '+row.row_number+' has an ambiguous separator. Confirm it with a decimal point.');
    amounts.push(stock.secondary(line,match[1].replace(',','.')));
  }
  if(!amounts.length||new Set(amounts).size!==1)
    throw new ValidationError(line.code+' needs one exact actual weight on source row '+row.row_number+'.');
  return amounts[0];
}

function selectedLine(order,lines,row,columns,transforms){
  const parsed=row.parsed;
  for(const column of columns.order){
    const reference=cell(row,column,transforms).replace(/^#/,'');
    if(reference&&reference.toLowerCase()!==order.po_number.toLowerCase())
      throw new ValidationError('The purchase-order reference on the slip differs from '+order.po_number+'.');
  }
  if(!Number.isFinite(Number(parsed.quantity))||Number(parsed.quantity)<=0)
    throw new ValidationError('Every delivered row needs one existing SKU or saved supplier code and a positive, reviewed quantity. Resolve the file preview first.');
  const lineNumbers=columns.line.map(column=>cell(row,column,transforms).replace(/^#/,'')).filter(Boolean);
  if(lineNumbers.some(value=>!/^\d+$/.test(value))||new Set(lineNumbers.map(Number)).size>1)
    throw new ValidationError('Source row '+row.row_number+' has an unclear purchase-order line number.');
  let candidates=parsed.existingSkuId?lines.filter(line=>line.sku_id===parsed.existingSkuId):lines;
  if(lineNumbers.length)candidates=candidates.filter(line=>Number(line.line_number)===Number(lineNumbers[0]));
  if(parsed.locationText){
    if(!parsed.locationId)throw new ValidationError('Confirm the actual receiving warehouse on source row '+row.row_number+'.');
    candidates=candidates.filter(line=>(line.destination_location_id||order.destination_location_id)===parsed.locationId);
  }
  const match=matchLine(candidates,parsed.existingSkuId?{skuId:parsed.existingSkuId}:{skuCode:parsed.sourceCode||parsed.code});
  if(!match)throw new ValidationError('Each source SKU or saved supplier code must match one exact PO line and warehouse. Include the PO line number or receiving warehouse for split lines.');
  // The general stock-import preview treats these as two catalogue tracking
  // modes. A native serial receipt can also retain its explicitly printed batch.
  const serialBatch=match.tracking_mode==='serial'&&parsed.serial&&parsed.lotCode&&row.status==='INVALID'&&
    row.problems?.length===1&&row.problems[0].code==='invalid_tracking_flag'&&
    row.problems[0].message==='A product cannot use both serial and lot tracking in the same import row.';
  // Repeated delivery rows add up to the physical quantity for an exact PO
  // line. That differs from a generic inventory file setting one stock position.
  const quantityDelivery=match.tracking_mode==='quantity'&&!parsed.lotCode&&!parsed.serial&&row.status==='INVALID'&&
    row.problems?.length>0&&row.problems.every(problem=>['duplicate_position','missing_tracking_identifier'].includes(problem.code));
  if(row.status!=='VALID'&&!serialBatch&&!quantityDelivery){
    const reason=String(row.problems?.[0]?.message||'Check its product and physical quantity in the original.').slice(0,240);
    throw new ValidationError('Review delivery source row '+row.row_number+'. '+reason);
  }
  return match;
}

function assemble(order,lines,rows,columns,transforms,basis){
  const groups=new Map();
  const lineTotals=new Map();
  const serials=new Set();
  for(const row of rows){
    const line=selectedLine(order,lines,row,columns,transforms);
    const parsed=row.parsed;
    if(basis==='stock'&&unit(parsed.unitLabel||'unit')!==unit(line.unit_label))
      throw new ValidationError('Confirm the source unit of measure for '+line.code+' against the PO.');
    if(basis==='purchase'&&columns.quantityUnit){
      const stated=cell(row,columns.quantityUnit,transforms);
      const approved=unit(line.purchase_unit),printed=unit(stated);
      const genericPack=approved==='unit'&&Number(line.units_per_purchase_unit)>1&&['box','case','carton','pack','bundle','pallet'].includes(printed);
      if(stated&&printed!==approved&&!genericPack)
        throw new ValidationError('The printed quantity unit on source row '+row.row_number+' differs from the approved purchase pack for '+line.code+'.');
    }
    const quantity=stock.validate(line,exact.convert(parsed.quantity,{numerator:String(basis==='purchase'?line.units_per_purchase_unit:1),
      precision:Number(line.quantity_precision)}));
    const weight=actualWeight(row,line,columns,transforms);
    const locationId=line.destination_location_id||order.destination_location_id;
    if(!locationId)throw new ValidationError('Choose the receiving warehouse on the PO first.');
    const lotCode=['lot','serial'].includes(line.tracking_mode)?parsed.lotCode||null:null;
    if(line.tracking_mode==='lot'&&!lotCode)throw new ValidationError('Record the received batch for '+line.code+'.');
    const key=JSON.stringify([line.id,lotCode]);
    const entry=groups.get(key)||{lineId:line.id,skuId:line.sku_id,code:line.code,name:line.name,variantLabel:line.variant_label,
      locationId,unit:line.unit_label,quantity:0,secondaryUnit:line.secondary_unit_label,secondaryQuantity:weight===null?null:0,
      unitCostMinor:money.userToMinor(line.unit_cost,order.currency),serials:[],lotCode,expiresAt:lotCode?parsed.expiresAt||null:null};
    if(lotCode&&entry.expiresAt&&parsed.expiresAt&&entry.expiresAt!==parsed.expiresAt)
      throw new ValidationError('Source rows give different expiry dates for batch '+lotCode+'.');
    if(lotCode&&!entry.expiresAt&&parsed.expiresAt)entry.expiresAt=parsed.expiresAt;
    if(line.tracking_mode==='serial'){
      const serialKey=JSON.stringify([line.sku_id,String(parsed.serial||'').toLowerCase()]);
      if(quantity!==1||!parsed.serial||serials.has(serialKey))throw new ValidationError('Provide each received serial exactly once, with one stock unit per source row.');
      serials.add(serialKey);
      entry.serials.push(parsed.serial);
      if(weight!==null){
        entry.serialWeights??=Object.create(null);
        entry.serialWeights[parsed.serial]=weight;
      }
    }
    entry.quantity=exact.safeNumber(exact.add(entry.quantity,quantity));
    if(weight!==null)entry.secondaryQuantity=exact.safeNumber(exact.add(entry.secondaryQuantity,weight));
    const total=exact.safeNumber(exact.add(lineTotals.get(line.id)||0,quantity));
    if(total>Number(exact.subtract(line.quantity_units,line.quantity_received_units)))
      throw new ValidationError('The slip exceeds the units still due for '+line.code+'. Review the difference with the supplier.');
    lineTotals.set(line.id,total);
    groups.set(key,entry);
  }
  return [...groups.values()];
}

module.exports={sourceColumns,assemble};
