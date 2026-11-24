'use strict';
const fs=require('node:fs'),path=require('node:path');
// The product video and its chapters, filmed from the real app (see manifest.json).
function current(){const folder=path.join(__dirname,'../web/public/demo'),manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
  const present=file=>Boolean(file)&&fs.existsSync(path.join(folder,file));
  if(!manifest.actualBrowser||!manifest.actualPostgreSQL||!present(manifest.video)||!present(manifest.poster))throw new Error('The verified product demonstration has not been built.');
  return {...manifest,webm:present(manifest.webm)?manifest.webm:null,screens:manifest.screens.filter(s=>/^[a-z]+\.(png|jpg)$/.test(s.file)&&present(s.file))};}
module.exports={current};
