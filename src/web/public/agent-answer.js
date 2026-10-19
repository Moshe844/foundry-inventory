'use strict';
// Small, shared presentation renderer. Model HTML is always escaped; only
// paragraphs, lists, emphasis, code, local links and pipe tables produce markup.
(function(root){
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const emphasis=s=>escape(s).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
 function localHref(value){
  if(!value.startsWith('/')||value.startsWith('//')||value.length>2000||/[\\\u0000-\u0020\u007f]/.test(value))return null;
  let decoded=value;try{for(let depth=0;depth<8;depth++){const next=decodeURIComponent(decoded);if(next===decoded)break;decoded=next;}}catch{return null;}
  if(decoded.startsWith('//')||/[\\\u0000-\u001f\u007f]/.test(decoded)||/%(?:25)*(?:2e|2f|5c|0[ad])/i.test(decoded)||decoded.split(/[?#]/)[0].split('/').some(part=>part==='.'||part==='..'))return null;
  const url=new URL(value,'https://stockchief.invalid');
  if(url.origin!=='https://stockchief.invalid'||url.pathname!==value.split(/[?#]/)[0])return null;
  // Browser-session authorization links cannot be transferred into a chat.
  if([...url.searchParams.keys()].some(key=>/csrf|token|secret|ticket|password|authorization|session|nonce|^state$/.test(key.replace(/[^a-z0-9]/gi,'').toLowerCase())))return null;
  return value;
 }
 function inline(value){
  const text=String(value),tokens=/(`+)|\[([^\]\n]+)\]\([ \t]*([^\s)]+)[ \t]*\)|\\([\\`*_[\]{}()#+.!|~>-])/g;let out='',at=0,match;
  while((match=tokens.exec(text))){out+=emphasis(text.slice(at,match.index));
   if(match[1]!==undefined){const delimiter=match[1],start=tokens.lastIndex;let end=text.indexOf(delimiter,start);while(end>=0&&(text[end-1]==='`'||text[end+delimiter.length]==='`'))end=text.indexOf(delimiter,end+delimiter.length);if(end>=0){out+='<code>'+escape(text.slice(start,end))+'</code>';tokens.lastIndex=end+delimiter.length;}else out+=escape(delimiter);}
   else if(match[4]!==undefined)out+=escape(match[4]);
   else{const href=localHref(match[3]);out+=href?'<a href="'+escape(href)+'">'+emphasis(match[2])+'</a>':emphasis(match[2]);}
   at=tokens.lastIndex;
  }
  return out+emphasis(text.slice(at));
 }
 const cells=line=>{const text=line.trim().replace(/^\|/,'').replace(/\|$/,''),result=[];let cell='';for(let i=0;i<text.length;i++){if(text[i]==='\\'&&i+1<text.length){cell+=text[i]+text[++i];continue;}if(text[i]==='|'){result.push(cell.trim());cell='';}else cell+=text[i];}result.push(cell.trim());return result;};
 function render(value){
  const lines=String(value||'').replace(/\r\n?/g,'\n').split('\n'),out=[];let i=0;
  while(i<lines.length){
   if(!lines[i].trim()){i++;continue;}
   const fence=lines[i].match(/^\s{0,3}(`{3,})[^`]*$/)||lines[i].match(/^\s{0,3}(~{3,})/);
   if(fence){const end=new RegExp('^\\s{0,3}'+fence[1][0]+'{'+fence[1].length+',}\\s*$'),code=[];i++;while(i<lines.length&&!end.test(lines[i]))code.push(lines[i++]);if(i<lines.length)i++;out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue;}
   if(/^(?: {4}|\t)/.test(lines[i])){const code=[];while(i<lines.length&&(!lines[i].trim()||/^(?: {4}|\t)/.test(lines[i])))code.push(lines[i++].replace(/^(?: {4}|\t)/,''));out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue;}
   const heading=lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
   if(heading){out.push('<h3 class="rm-agent__heading">'+inline(heading[1])+'</h3>');i++;continue;}
   const header=cells(lines[i]),separator=i+1<lines.length?cells(lines[i+1]):[];
   if(lines[i].includes('|')&&header.length>=1&&header.length===separator.length&&separator.every(s=>/^:?-{3,}:?$/.test(s))){
    const align=separator.map(s=>s.endsWith(':')?(s.startsWith(':')?'center':'right'):'left');i+=2;
    let body='';while(i<lines.length&&lines[i].includes('|')&&cells(lines[i]).length===header.length){
     body+='<tr>'+cells(lines[i++]).map((s,n)=>`<td style="text-align:${align[n]}">${inline(s)}</td>`).join('')+'</tr>';
    }
    out.push('<div class="rm-agent__table"><table><thead><tr>'+header.map((s,n)=>`<th scope="col" style="text-align:${align[n]}">${inline(s)}</th>`).join('')+'</tr></thead><tbody>'+body+'</tbody></table></div>');continue;
   }
   if(/^\s*[-*•]\s+/.test(lines[i])){let rows='';while(i<lines.length&&/^\s*[-*•]\s+/.test(lines[i]))rows+='<li>'+inline(lines[i++].replace(/^\s*[-*•]\s+/,''))+'</li>';out.push('<ul>'+rows+'</ul>');continue;}
   const paragraph=[];while(i<lines.length&&lines[i].trim()){
    if(paragraph.length&&(/^\s*[-*•]\s+/.test(lines[i])||/^\s{0,3}(?:#{1,6}\s+|`{3,}|~{3,})/.test(lines[i])||/^(?: {4}|\t)/.test(lines[i])||lines[i].includes('|')&&i+1<lines.length&&cells(lines[i+1]).every(s=>/^:?-{3,}:?$/.test(s))))break;
    paragraph.push(inline(lines[i++]));
   }
   out.push('<p>'+paragraph.join('<br>')+'</p>');
  }
  return out.join('');
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={render};else root.StockChiefAnswer={render};
})(typeof window==='undefined'?{}:window);
