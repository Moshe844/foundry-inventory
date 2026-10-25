'use strict';
// Only a validated domain operation can authorize reversing its owned journal.
// A string in an HTTP payload or copied journal metadata cannot grant this.
const costReversals=new WeakSet();
function costReversal(input){costReversals.add(input);return input;}
function allowsCostReversal(input){return costReversals.has(input);}
module.exports={costReversal,allowsCostReversal};
