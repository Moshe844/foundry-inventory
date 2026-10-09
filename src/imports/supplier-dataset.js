'use strict';

// A supplier directory is not a product catalog. Classify from the schema,
// not the filename: uploaded files are often named "inventory.csv".
const fields=require('./fields');
const {newId,trimOrNull}=require('../lib/util');

const CONTACT_FIELDS=Object.freeze({
  name:/^(?:supplier|vendor)(?: name)?$|^(?:company|business) name$/,
  contactName:/^(?:contact|contact name|contact person|person)$/,
  email:/^(?:email|e mail|email address|contact email)$/,
  phone:/^(?:phone|telephone|tel|contact phone)$/,
  paymentTerms:/^(?:terms|payment terms|terms of payment)$/,
  code:/^(?:supplier|vendor) (?:code|id|number)$/,
});
const PRODUCT_MARKER=/\b(?:sku|product|item|part|barcode|gtin|quantity|qty|on hand|stock count|unit cost|selling price)\b/;

function classify(columns){
  const headers=columns.map((column)=>fields.normalise(column.name));
  if(headers.some((header)=>PRODUCT_MARKER.test(header)))return null;
  const mappings={};
  for(const [field,pattern] of Object.entries(CONTACT_FIELDS)){
    const index=headers.findIndex((header)=>pattern.test(header));
    if(index>=0)mappings[field]=columns[index].index;
  }
  const contactSignals=['contactName','email','phone','paymentTerms'].filter((field)=>mappings[field]!==undefined);
  return mappings.name!==undefined&&contactSignals.length>=1?mappings:null;
}

function validate(sheet,mappings,existingNames=[]){
  const seen=new Set(existingNames.map((name)=>String(name).toLowerCase()));
  return sheet.rows.map((row)=>{
    const value=(field)=>mappings[field]===undefined?null:trimOrNull(row.cells[mappings[field]]);
    const parsed={name:value('name'),contactName:value('contactName'),email:value('email'),
      phone:value('phone'),paymentTerms:value('paymentTerms'),code:value('code')};
    const problems=[];
    if(!parsed.name)problems.push({code:'supplier_name_missing',message:'This row has no supplier name.'});
    if(parsed.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed.email))
      problems.push({code:'supplier_email_invalid',message:'This email address is not valid.'});
    if(parsed.name&&seen.has(parsed.name.toLowerCase()))
      problems.push({code:'supplier_duplicate',message:'A supplier with this name already exists or appears earlier in this file.'});
    if(parsed.name)seen.add(parsed.name.toLowerCase());
    return {id:newId('improw'),rowNumber:row.sourceRow,raw:row.cells,parsed,problems,
      status:problems.length?'INVALID':'VALID'};
  });
}

module.exports={classify,validate,CONTACT_FIELDS};
