'use strict';
const {ValidationError}=require('./errors');
const MAX_DIGITS=30,MAX_SCALE=9;
function decimal(value,{label='Quantity',signed=false,scale=MAX_SCALE}={}){
 if(typeof value!=='string'&&typeof value!=='number')throw new ValidationError(label+' must be an exact decimal.');
 const text=String(value).trim();if(text.length>MAX_DIGITS+MAX_SCALE+3)throw new ValidationError(label+' exceeds the supported exact range.');
 const match=/^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);if(!match)throw new ValidationError(label+' must use decimal notation without exponents or separators.');
 const fraction=(match[3]||'').replace(/0+$/,'');if(fraction.length>scale)throw new ValidationError(label+' has more than '+scale+' decimal places.');
 let coefficient=BigInt(match[2]+fraction);if(match[1]==='-')coefficient=-coefficient;
 if(!signed&&coefficient<0n)throw new ValidationError(label+' cannot be negative.');
 if((coefficient<0n?-coefficient:coefficient).toString().length>MAX_DIGITS)throw new ValidationError(label+' exceeds the supported exact range.');
 return {coefficient,scale:fraction.length};
}
function format(coefficient,scale=0){
 const negative=coefficient<0n;let digits=(negative?-coefficient:coefficient).toString().padStart(scale+1,'0');
 if(scale)digits=digits.slice(0,-scale)+'.'+digits.slice(-scale);return (negative?'-':'')+digits.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
}
function canonical(value,options){const d=decimal(value,options);return format(d.coefficient,d.scale);}
function atoms(value,precision,{positive=false,...options}={}){
 if(!Number.isInteger(precision)||precision<0||precision>MAX_SCALE)throw new ValidationError('Stock precision must be between zero and nine decimal places.');
 const d=decimal(value,{...options,scale:precision}),units=d.coefficient*10n**BigInt(precision-d.scale);
 if(positive&&units<=0n)throw new ValidationError((options.label||'Quantity')+' must be above zero.');
 if(units>BigInt(Number.MAX_SAFE_INTEGER)||units<BigInt(Number.MIN_SAFE_INTEGER))throw new ValidationError('Stock quantity exceeds the supported exact range.');return Number(units);
}
function fromAtoms(value,precision){if(!Number.isSafeInteger(value))throw new ValidationError('Stock units must be an exact integer.');if(!Number.isInteger(precision)||precision<0||precision>MAX_SCALE)throw new ValidationError('Invalid stock precision.');return format(BigInt(value),precision);}
function convert(value,{numerator='1',denominator='1',precision=MAX_SCALE}={}){
 const d=decimal(value),n=decimal(numerator),b=decimal(denominator);if(n.coefficient<=0n||b.coefficient<=0n)throw new ValidationError('Unit conversion must be positive.');
 if(!Number.isInteger(precision)||precision<0||precision>MAX_SCALE)throw new ValidationError('Invalid conversion precision.');
 const top=d.coefficient*n.coefficient*10n**BigInt(b.scale+precision),bottom=b.coefficient*10n**BigInt(d.scale+n.scale);
 if(top%bottom!==0n)throw new ValidationError('This quantity cannot be represented exactly in the stocking unit.');
 return canonical(format(top/bottom,precision),{scale:precision});
}
function costMinor(quantity,unitCostMinor,{perQuantity='1'}={}){
 const q=decimal(quantity),price=decimal(unitCostMinor,{label:'Unit cost',scale:0}),per=decimal(perQuantity);if(per.coefficient<=0n)throw new ValidationError('Price quantity must be above zero.');
 const numerator=q.coefficient*price.coefficient*10n**BigInt(per.scale),denominator=per.coefficient*10n**BigInt(q.scale);
 // Round half up once, at the monetary posting boundary. Physical quantities never round.
 const result=(numerator*2n+denominator)/(denominator*2n);if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError('Stock value exceeds the supported exact range.');return Number(result);
}

function combine(left,right,subtract=false){const a=decimal(left,{signed:true}),b=decimal(right,{signed:true}),scale=Math.max(a.scale,b.scale);return format(a.coefficient*10n**BigInt(scale-a.scale)+(subtract?-1n:1n)*b.coefficient*10n**BigInt(scale-b.scale),scale);}
function safeNumber(value,{precision=6,signed=false,positive=false,label='Quantity'}={}){const text=canonical(value,{label,signed,scale:precision}),n=Number(text);if(!Number.isFinite(n)||Math.abs(n)>Number.MAX_SAFE_INTEGER||canonical(String(n),{signed:true,scale:precision})!==text)throw new ValidationError(label+' exceeds the supported exact range.');if(positive&&n<=0)throw new ValidationError(label+' must be above zero.');return n;}
function ratioMinor(total,numerator,denominator,{rounding='half_up'}={}){if(!Number.isSafeInteger(total)||total<0)throw new ValidationError('The value must be an exact non-negative minor amount.');const n=decimal(numerator),d=decimal(denominator);if(d.coefficient<=0n)throw new ValidationError('The valuation quantity must be positive.');const top=BigInt(total)*n.coefficient*10n**BigInt(d.scale),bottom=d.coefficient*10n**BigInt(n.scale);if(!['half_up','floor'].includes(rounding))throw new ValidationError('Unsupported monetary rounding.');const result=rounding==='floor'?top/bottom:(top*2n+bottom)/(bottom*2n);if(result>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError('The calculated value exceeds the supported exact range.');return Number(result);}
function portionMinor(total,quantity,before,take){const after=combine(before,take);if(decimal(combine(quantity,after,true),{signed:true}).coefficient<0n)throw new ValidationError('Quantity exceeds the historical line.');return ratioMinor(total,after,quantity,{rounding:'floor'})-ratioMinor(total,before,quantity,{rounding:'floor'});}
module.exports={MAX_SCALE,canonical,atoms,fromAtoms,convert,costMinor,safeNumber,add:(a,b)=>combine(a,b),subtract:(a,b)=>combine(a,b,true),ratioMinor,portionMinor};

