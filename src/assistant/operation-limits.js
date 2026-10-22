'use strict';
// A bounded full workflow must survive transport, canonical parsing, evidence
// synthesis and approval unchanged. Never silently keep only its first steps.
const MAX_OPERATIONS=32;
module.exports={MAX_OPERATIONS};
