'use strict';
const fs=require('node:fs'),path=require('node:path');
function current(){const folder=path.join(__dirname,'../web/public/demo'),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));if(!manifest.actualBrowser||!manifest.actualPostgreSQL||manifest.paidCalls!==0||!manifest.video||!fs.existsSync(path.join(folder,manifest.video)))throw new Error('The verified product demonstration has not been built.');return {...manifest,screens:manifest.screens.filter(s=>/^[a-z]+\.png$/.test(s.file))};}
module.exports={current};
