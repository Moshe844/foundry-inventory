'use strict';
// Small, shared presentation renderer. Model HTML is always escaped; only
// paragraphs, lists, emphasis, code and pipe tables produce markup.
(function(root){
 const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const inline=s=>escape(s).replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
 const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim());
 function render(value){
  const lines=String(value||'').replace(/\r\n?/g,'\n').split('\n'),out=[];let i=0;
  while(i<lines.length){
   if(!lines[i].trim()){i++;continue;}
   const heading=lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
   if(heading){out.push('<h3 class="rm-agent__heading">'+inline(heading[1])+'</h3>');i++;continue;}
   const header=cells(lines[i]),separator=i+1<lines.length?cells(lines[i+1]):[];
   if(lines[i].includes('|')&&header.length>1&&header.length===separator.length&&separator.every(s=>/^:?-{3,}:?$/.test(s))){
    const align=separator.map(s=>s.endsWith(':')?(s.startsWith(':')?'center':'right'):'left');i+=2;
    let body='';while(i<lines.length&&lines[i].includes('|')&&cells(lines[i]).length===header.length){
     body+='<tr>'+cells(lines[i++]).map((s,n)=>`<td style="text-align:${align[n]}">${inline(s)}</td>`).join('')+'</tr>';
    }
    out.push('<div class="rm-agent__table"><table><thead><tr>'+header.map((s,n)=>`<th scope="col" style="text-align:${align[n]}">${inline(s)}</th>`).join('')+'</tr></thead><tbody>'+body+'</tbody></table></div>');continue;
   }
   if(/^\s*[-*•]\s+/.test(lines[i])){let rows='';while(i<lines.length&&/^\s*[-*•]\s+/.test(lines[i]))rows+='<li>'+inline(lines[i++].replace(/^\s*[-*•]\s+/,''))+'</li>';out.push('<ul>'+rows+'</ul>');continue;}
   const paragraph=[];while(i<lines.length&&lines[i].trim()){
    if(paragraph.length&&(/^\s*[-*•]\s+/.test(lines[i])||/^\s{0,3}#{1,6}\s+/.test(lines[i])||lines[i].includes('|')&&i+1<lines.length&&cells(lines[i+1]).every(s=>/^:?-{3,}:?$/.test(s))))break;
    paragraph.push(inline(lines[i++]));
   }
   out.push('<p>'+paragraph.join('<br>')+'</p>');
  }
  return out.join('');
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={render};else root.StockChiefAnswer={render};
})(typeof window==='undefined'?{}:window);
