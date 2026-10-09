'use strict';

const {newId}=require('../lib/util');

// A source hash detects duplicate inventory, while a submission key identifies
// one billable analysis attempt. They must not be the same lifetime key: a user
// may legitimately preview a corrected/cancelled file again.
function analysisUsageKey(sourceHash,submissionKey){
  return `import-analysis:${sourceHash}:${submissionKey||newId('importpreview')}`;
}

module.exports={analysisUsageKey};
