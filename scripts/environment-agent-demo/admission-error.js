'use strict';
// Stable, non-sensitive reasons for the host's fail-closed admission boundary.
// Retain the public code; never include a source path, credential or request.
module.exports=kind=>Object.assign(new Error('STAGING_CODEX_ADMISSION_BLOCKED'),{
 code:'STAGING_CODEX_ADMISSION_BLOCKED',limitKind:kind});
