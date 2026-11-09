'use strict';
const reversals=new WeakSet();
module.exports={reversal:input=>{reversals.add(input);return input;},allowsReversal:input=>reversals.has(input)};
