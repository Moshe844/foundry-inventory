'use strict';

const crypto=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const currency=require('../domain/currency');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function accountShape(provider,row){
  const compact=value=>String(value||'').replace(/[^a-z]/gi,'').toUpperCase();
  const classification=compact(row.classification),typeName=compact(row.accountType);
  const classes={ASSET:'ASSET',ASSETS:'ASSET',LIABILITY:'LIABILITY',LIABILITIES:'LIABILITY',
    EQUITY:'EQUITY',REVENUE:'INCOME',INCOME:'INCOME',EXPENSE:'EXPENSE',EXPENSES:'EXPENSE'};
  const types={BANK:'ASSET',ACCOUNTSRECEIVABLE:'ASSET',OTHERASSET:'ASSET',OTHERCURRENTASSET:'ASSET',
    FIXEDASSET:'ASSET',CURRENT:'ASSET',FIXED:'ASSET',INVENTORY:'ASSET',NONCURRENT:'ASSET',PREPAYMENT:'ASSET',
    ACCOUNTSPAYABLE:'LIABILITY',CREDITCARD:'LIABILITY',OTHERCURRENTLIABILITY:'LIABILITY',LONGTERMLIABILITY:'LIABILITY',
    CURRLIAB:'LIABILITY',TERMLIAB:'LIABILITY',LIABILITY:'LIABILITY',EQUITY:'EQUITY',INCOME:'INCOME',
    OTHERINCOME:'INCOME',REVENUE:'INCOME',SALES:'INCOME',EXPENSE:'EXPENSE',OTHEREXPENSE:'EXPENSE',
    DEPRECIATN:'EXPENSE',OVERHEADS:'EXPENSE'};
  const cogs=['COSTOFGOODSSOLD','COGS','DIRECTCOSTS','DIRECTCOST'].includes(typeName);
  const type=cogs?'COGS':classes[classification]||types[typeName];
  if(!type)throw new ValidationError('The provider account type requires review before starting balances can be imported.');
  if(classes[classification]&&types[typeName]&&classes[classification]!==types[typeName])
    throw new ValidationError('The provider account classification conflicts with its account type.');
  if(cogs&&classes[classification]&&classes[classification]!=='EXPENSE')
    throw new ValidationError('The provider cost account classification requires review.');
  const prefix=String(provider).toLowerCase()==='quickbooks'?'QB':String(provider).toLowerCase()==='xero'?'XE':'EXT';
  return {code:prefix+'-'+digest(String(row.externalId)).slice(0,20).toUpperCase(),name:row.name,
    type,normalBalance:['ASSET','EXPENSE','COGS'].includes(type)?'DEBIT':'CREDIT',subtype:row.accountSubType||row.accountType||null};
}

function scope(provider,snapshot){
  if(!snapshot||!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf||'')||
      !Number.isFinite(Date.parse(snapshot.asOf+'T00:00:00Z'))||new Date(snapshot.asOf+'T00:00:00Z').toISOString().slice(0,10)!==snapshot.asOf)
    throw new ValidationError('The provider starting-balance date is invalid.');
  if(!snapshot.currency)throw new ValidationError('The provider must identify the accounting currency.');
  const code=currency.code(snapshot.currency);
  if(!Array.isArray(snapshot.accounts)||!snapshot.accounts.length)throw new ValidationError('The provider returned no accounting identities.');
  const ids=new Set();let debitMinor=0,creditMinor=0;
  const accounts=snapshot.accounts.map(row=>{
    if(typeof row.externalId!=='string'||!row.externalId.trim()||ids.has(row.externalId))
      throw new ValidationError('The provider account identities are missing or duplicated.');
    ids.add(row.externalId);
    if(!Number.isSafeInteger(row.balanceMinor)||typeof row.name!=='string'||!row.name.trim()||row.name.length>120)
      throw new ValidationError('The provider starting balances or account names require review.');
    const shape=accountShape(provider,row);
    debitMinor+=Math.max(0,row.balanceMinor);creditMinor+=Math.max(0,-row.balanceMinor);
    if(!Number.isSafeInteger(debitMinor)||!Number.isSafeInteger(creditMinor))throw new ValidationError('The provider starting balances exceed supported precision.');
    return {externalId:row.externalId,name:row.name,balanceMinor:row.balanceMinor,shape};
  }).sort((a,b)=>a.externalId.localeCompare(b.externalId,'en'));
  // Provider response timestamps and chart version tokens are not money or
  // approved account identity. A refreshed identical report has the same scope.
  const core={provider:String(provider).toLowerCase(),asOf:snapshot.asOf,currency:code,accounts};
  return {...core,currencyExponent:currency.exponent(code),scopeHash:digest(core),accountCount:accounts.length,
    nonzeroCount:accounts.filter(row=>row.balanceMinor!==0).length,debitMinor,creditMinor,balanced:debitMinor===creditMinor};
}

module.exports={scope,accountShape};
