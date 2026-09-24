'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('../src/config');
const { openDatabase } = require('../src/db');
const auth = require('../src/domain/auth-service');
const { createApp } = require('../src/app');
const modes = require('../src/autopilot/modes');

if (!process.argv.includes('--start')) throw new Error('Pass --start to open the isolated integration verification workspace.');
const directory = path.resolve(config.rootDir,'data/integration-verification');
const databasePath = path.join(directory,'verification.sqlite');
if (databasePath.toLowerCase() === path.resolve(config.databasePath).toLowerCase()) throw new Error('The verification database must be separate from the business database.');
fs.mkdirSync(directory,{recursive:true});
const db = openDatabase(databasePath);
const loginPath = path.join(directory,'login.json');
let login;
if (fs.existsSync(loginPath)) {
  login = JSON.parse(fs.readFileSync(loginPath,'utf8'));
} else {
  login = {email:'integration-owner@stockchief.test',password:crypto.randomBytes(24).toString('base64url')};
  const registered = auth.registerAccount(db,{...login,name:'Integration Verification Owner',workspaceName:'Integration Verification — No Live Operations'});
  modes.setMode(db,{workspaceId:registered.workspaceId,actorId:registered.userId},{id:registered.userId,role:'owner'},'OBSERVE');
  fs.writeFileSync(loginPath,JSON.stringify(login),{mode:0o600});
}
const app = createApp({db,env:'test',sessionSecret:config.sessionSecret});
const server = app.listen(Number(process.env.PORT || 4000),'127.0.0.1',()=>{
  console.log(`Isolated integration verification is at http://localhost:${server.address().port}/settings/connections`);
  console.log(`Local verification login is stored at ${loginPath}. No production records or scheduled operations are used.`);
});
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
