'use strict';

const {ValidationError}=require('../domain/errors');
const sheets=require('../imports/parser');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');

const headers={
  code:/^(?:sku|sku code|item code|product code|supplier sku|supplier code|vendor sku|part number)$/i,
  amount:/^(?:(?:stock unit |unit |pack |case )?(?:price|cost)(?: excluding tax| ex vat| net)?)$/i,
  currency:/^(?:currency|currency code)$/i,
  unit:/^(?:unit|uom|price unit|pricing unit|price basis)$/i,
  quantity:/^(?:price per|price quantity|priced quantity|per quantity)$/i,
  pack:/^(?:pack size|units per pack|units per case|stock units per pack)$/i,
  supplier:/^(?:supplier|supplier name|vendor)$/i
};
const normalize=text=>String(text??'').normalize('NFKC').trim().replace(/[_-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\s+/g,' ');
const document=/\.(pdf|docx|png|jpe?g|webp|gif|heic|heif|tiff?)$/i;
const priceLabel=value=>normalize(value).replace(/\s*\([A-Z]{3}\)$/i,'');

function documentTable(page){
  const native=page.nativeGeometryComplete&&page.nativeWords?.length?
    require('./supplier-invoice-visual-table').text({ocrWords:page.nativeWords},{columns:cells=>
      cells.some(cell=>headers.code.test(normalize(cell)))&&cells.some(cell=>headers.amount.test(priceLabel(cell)))}):null;
  return native||page.invoiceText||page.text;
}

function parseSheet(sheet){
  const fields={};
  for(const [key,pattern] of Object.entries(headers)){
    const found=sheet.columns.filter(col=>pattern.test(key==='amount'?priceLabel(col.name):normalize(col.name)));
    if(found.length>1)throw new ValidationError('The '+sheet.name+' table has more than one '+key+' column. Choose the exact source.');
    if(found.length===1)fields[key]=found[0].index;
  }
  if(fields.amount==null)return [];
  if(fields.code==null)throw new ValidationError('The '+sheet.name+' pricing table has no exact SKU column.');
  const preamble=(sheet.preamble||[]).map(row=>row.join(' '));
  if([...sheet.columns.map(col=>col.name),...preamble].some(value=>/\b(?:incl\.?|includes?|including)\s*(?:tax|vat|gst)\b/i.test(value)))
    throw new ValidationError('The price list includes tax-inclusive amounts. Confirm a comparable goods-price column before reviewing it.');
  const amountHeader=sheet.columns.find(col=>col.index===fields.amount).name;
  const statedCurrencies=new Set([
    /\(([A-Z]{3})\)$/i.exec(amountHeader)?.[1],
    ...preamble.map(line=>/^currency(?: code)?(?:\s*[:=]\s*|\s+)([A-Z]{3})\s*$/i.exec(line)?.[1])
  ].filter(Boolean).map(currency=>money.code(currency)));
  if(statedCurrencies.size>1)throw new ValidationError('The price list gives conflicting currencies for this table.');
  const [tableCurrency]=statedCurrencies;
  return sheet.rows.filter(row=>row.cells.some(cell=>String(cell??'').trim())).map(row=>{
    const field=key=>fields[key]==null?'':String(row.cells[fields[key]]??'').trim();
    return {sheet:sheet.name,rowNumber:row.sourceRow,code:field('code'),amount:field('amount'),currency:field('currency')||tableCurrency||'',tableCurrency,
      unit:field('unit')||(/^pack/i.test(amountHeader)?'pack':/^case/i.test(amountHeader)?'case':/^stock unit/i.test(amountHeader)?'stock unit':''),
      quantity:field('quantity'),pack:field('pack'),supplier:field('supplier'),raw:row.cells};
  });
}

async function read(file){
  let source;
  try{
    if(document.test(file.filename)){
      const pages=await require('../documents/contract-source').read({...file,invoiceLayout:true});
      if(pages.some(page=>page.requiresSourceConfirmation||['scan','mixed'].includes(page.sourceKind)))
        throw new ValidationError('Open the retained original and confirm the exact pricing table before comparing scanned or mixed content.');
      source=pages.flatMap(page=>sheets.parse({text:documentTable(page),filename:'table.txt'}).sheets.map(sheet=>({...sheet,name:'Page '+page.page})));
    }else source=sheets.parse(file).sheets;
  }catch(error){throw new ValidationError(error.message||'The original price list could not be read.');}
  const rows=source.flatMap(parseSheet);
  if(!rows.length)throw new ValidationError('The original needs a table with an exact SKU and goods price, plus recorded currency and price unit.');
  return rows;
}

function comparable(row,product){
  if(!row.amount||!row.currency)throw new ValidationError('A recorded price and currency are required.');
  const currency=money.code(row.currency),amountMinor=money.userToMinor(row.amount,currency,{label:'Supplier price'});
  if(amountMinor<0)throw new ValidationError('A supplier price cannot be negative.');
  const unit=normalize(row.unit).toLowerCase(),stockUnit=normalize(product.secondary_unit_label||product.unit_label).toLowerCase();
  const purchaseUnit=normalize(product.purchase_unit).toLowerCase();
  const statedQuantity=row.quantity?exact.safeNumber(row.quantity,{positive:true,label:'Price quantity'}):1;
  if(unit===stockUnit||!product.secondary_unit_label&&(
    ['stock','stock unit','stock units'].includes(unit)||(!unit||unit==='unit')&&Number(product.units_per_purchase_unit)===1
  )){
    if(row.pack)throw new ValidationError('The row gives a pack count and a stock-unit price. Confirm which price the source uses.');
    return {currency,amountMinor,pricingQuantity:statedQuantity,unit:stockUnit};
  }
  if(product.secondary_unit_label)throw new ValidationError('A pack or piece count cannot establish this product’s independent measured price unit.');
  if(!purchaseUnit||!(unit===purchaseUnit||['pack','case','box','carton'].includes(unit)&&/^(?:pack|case|box|carton)s?$/.test(purchaseUnit)))
    throw new ValidationError('The price unit is unclear or differs from the saved supplier pack.');
  const known=exact.canonical(String(product.units_per_purchase_unit));
  if(row.pack&&exact.canonical(row.pack)!==known)throw new ValidationError('The printed pack size differs from the saved supplier pack.');
  return {currency,amountMinor,pricingQuantity:exact.safeNumber(exact.convert(statedQuantity,{numerator:known,precision:6}),{positive:true}),unit:stockUnit};
}

module.exports={read,comparable};
