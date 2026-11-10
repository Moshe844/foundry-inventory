'use strict';

const {ValidationError}=require('./errors');

const maximum=1000000000n;
const scale=18;
const factor=10n**BigInt(scale);

function decimal(value,label){
  const text=String(value??'').trim().replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
  const match=/^(\d{1,14})(?:\.(\d{1,18}))?$/.exec(text);
  if(/^-\d+(?:\.\d+)?$/.test(text))throw new ValidationError(label+' must be positive.');
  if(!match)throw new ValidationError(label+' needs a plain decimal value.');
  const fraction=match[2]||'';
  return {numerator:BigInt(match[1]+fraction),denominator:10n**BigInt(fraction.length)};
}

function formatted(atoms){
  const whole=atoms/factor;
  const fraction=atoms%factor;
  if(!fraction)return Number(whole);
  return whole+'.'+fraction.toString().padStart(scale,'0').replace(/0+$/,'');
}

function convert(value,{numerator=1,denominator=1,label='Measurement',limit=maximum}={}){
  const source=decimal(value,label);
  const top=source.numerator*BigInt(numerator)*factor;
  const bottom=source.denominator*BigInt(denominator);
  if(top<=0n||bottom<=0n||top>BigInt(limit)*factor*bottom){
    throw new ValidationError(label+' must be positive and at most '+BigInt(limit).toLocaleString('en-US')+' in its recorded unit.');
  }
  if(top%bottom)throw new ValidationError(label+' has more precision than this field can store exactly.');
  return formatted(top/bottom);
}

function optional(value,label,limit){
  if(value==null||String(value).trim()==='')return null;
  return convert(value,{label,limit});
}

function sum(values,label='Combined parcel weight',limit=maximum){
  if(!values.length)return null;
  let total=0n;
  for(const value of values){
    const checked=convert(value,{label,limit});
    const source=decimal(checked,label);
    total+=source.numerator*(factor/source.denominator);
  }
  if(total>BigInt(limit)*factor)throw new ValidationError(label+' exceeds the supported exact range.');
  return formatted(total);
}

function compare(left,right){
  const a=decimal(left,'Parcel weight'),b=decimal(right,'Weight limit');
  const difference=a.numerator*b.denominator-b.numerator*a.denominator;
  return difference===0n?0:difference>0n?1:-1;
}

module.exports={convert,optional,sum,compare};
