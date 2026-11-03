'use strict';
function assertDatabase(value){const url=new URL(value);if(!['dpg-damlkhuk1f9s739h5ga0-a','dpg-damlkhuk1f9s739h5ga0-a.virginia-postgres.render.com'].includes(url.hostname)||url.pathname!=='/stockchief_staging')throw Error('Staging database guard');return url;}
module.exports={assertDatabase};
