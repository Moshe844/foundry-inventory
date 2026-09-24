'use strict';

const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;

if(connectionString){
  const startup=require('./postgres-web-server').startPostgresWeb({connectionString});
  startup.catch((error)=>{console.error('[stockchief] PostgreSQL web startup failed:',error);process.exitCode=1;});
  module.exports={startup,engine:'postgresql'};
}else{
  if((process.env.NODE_ENV||'development')==='production'){
    throw new Error('Production StockChief requires FOUNDRY_DATABASE_URL. SQLite production startup is disabled.');
  }
  module.exports=require('./sqlite-server');
}
