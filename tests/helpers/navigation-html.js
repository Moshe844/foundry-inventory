'use strict';
const assert=require('node:assert/strict');
function sidebar(html){const match=/<header\b[^>]*id="app-sidebar"[^>]*>([\s\S]*?)<\/header>/.exec(html);assert(match,'The application sidebar must render');return match[1];}
function anchors(html){return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(m=>({href:/\bhref="([^"]+)"/.exec(m[1])?.[1],current:/\baria-current="page"/.test(m[1]),label:m[2].replace(/<svg\b[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,'').trim()}));}
module.exports={sidebar,anchors};
