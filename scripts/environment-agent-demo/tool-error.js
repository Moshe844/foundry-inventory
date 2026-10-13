'use strict';
// Persist a bounded machine code, never raw SQL, prompts or provider secrets.
function code(error){const value=error.code||error.message;return typeof value==='string'&&/^(?:[A-Z][A-Z0-9_]{1,100}|[A-Z0-9]{5})$/i.test(value)?value:'TOOL_FAILED';}
module.exports={code};
