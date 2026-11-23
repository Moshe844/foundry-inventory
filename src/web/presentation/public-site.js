'use strict';
const statusUrl='https://moshe844.github.io/stockchief-status/';
const paths=['/','/demo','/how-stockchief-works','/capabilities','/integrations','/switching','/pricing','/control','/security','/api/docs','/roadmap','/privacy','/terms'];
function canonicalOrigin(configured){
 try{const url=new URL(configured);if(url.protocol==='https:'&&!url.username&&!url.password)return url.origin;}catch{}
 return 'https://app.stockchiefhq.com';
}
function sitemap(configured){const origin=canonicalOrigin(configured);return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+paths.map(path=>'<url><loc>'+origin+path+'</loc></url>').join('')+'</urlset>';}
module.exports={statusUrl,paths,canonicalOrigin,sitemap};
