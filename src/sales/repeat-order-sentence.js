'use strict';
// Job 53: "same as last month", "repeat my usual order" and the same sentence
// in Spanish, French, German, Italian, Portuguese or Dutch. Questions in other
// alphabets reach this through Ask's English reading. A sentence is only a
// repeat request when nothing else is left in it: one more instruction makes it
// a question for a person.
//
// Readings: previous-month (the order from last calendar month), latest (the
// last order) and usual (the lines the customer orders most of the time, or
// the last order when there is no clear pattern).
const phrases=[
  ['previous-month',[
    /\b(?:the\s+)?same\s+(?:order\s+|thing\s+)?(?:as|like)\s+last\s+month\b/,/\blike\s+last\s+month\b/,/\blast\s+month'?s\s+order\b/,
    /\b(?:the\s+)?order\s+from\s+last\s+month\b/,/\b(?:repeat|reorder|re-order)\s+last\s+month\b/,
    /\blo\s+mismo\s+que\s+el\s+mes\s+pasado\b/,/\bigual\s+que\s+el\s+mes\s+pasado\b/,/\bel\s+(?:mismo\s+)?pedido\s+del\s+mes\s+pasado\b/,
    /\b(?:la\s+)?m[êe]me\s+(?:chose|commande)\s+que\s+le\s+mois\s+dernier\b/,/\bcomme\s+le\s+mois\s+dernier\b/,/\bla\s+commande\s+du\s+mois\s+dernier\b/,
    /\b(?:dasselbe|das\s+gleiche|die\s+gleiche\s+bestellung)\s+wie\s+(?:im\s+)?(?:letzten|vorigen|letzter)\s+monat\b/,/\bwie\s+(?:im\s+)?letzten\s+monat\b/,/\bdie\s+bestellung\s+vom\s+letzten\s+monat\b/,
    /\b(?:lo\s+stesso(?:\s+ordine)?|la\s+stessa\s+cosa)\s+del\s+mese\s+scorso\b/,/\bcome\s+il\s+mese\s+scorso\b/,/\bl'ordine\s+del\s+mese\s+scorso\b/,
    /\bo\s+mesmo\s+(?:pedido\s+)?(?:do|que\s+no)\s+m[êe]s\s+passado\b/,/\bcomo\s+no\s+m[êe]s\s+passado\b/,/\bo\s+pedido\s+do\s+m[êe]s\s+passado\b/,
    /\bhetzelfde\s+als\s+vorige\s+maand\b/,/\bde\s+bestelling\s+van\s+vorige\s+maand\b/]],
  ['latest',[
    /\b(?:the\s+)?same\s+(?:order\s+|thing\s+)?as\s+last\s+time\b/,/\blast\s+order\b/,/\bsame\s+again\b/,
    /\blo\s+mismo\s+que\s+la\s+[úu]ltima\s+vez\b/,/\b(?:el|mi|nuestro)\s+[úu]ltimo\s+pedido\b/,
    /\b(?:la\s+)?m[êe]me\s+(?:chose|commande)\s+que\s+la\s+derni[èe]re\s+fois\b/,/\b(?:ma|notre|la)\s+derni[èe]re\s+commande\b/,
    /\bwie\s+letztes\s+mal\b/,/\b(?:meine|unsere|die)\s+letzte\s+bestellung\b/,
    /\b(?:lo\s+stesso|la\s+stessa\s+cosa)\s+dell'ultima\s+volta\b/,/\b(?:il\s+mio|il\s+nostro|l')\s*ultimo\s+ordine\b/,
    /\bo\s+mesmo\s+da\s+[úu]ltima\s+vez\b/,/\b(?:o\s+meu|o\s+nosso|o)\s+[úu]ltimo\s+pedido\b/,
    /\bhetzelfde\s+als\s+vorige\s+keer\b/,/\b(?:mijn|onze|de)\s+laatste\s+bestelling\b/]],
  ['usual',[
    /\b(?:my|our|the|their|his|her)\s+(?:usual|regular|normal|standing)\s+order\b/,/\b(?:usual|regular|standing)\s+order\b/,/\bthe\s+usual\b/,/\bsame\s+as\s+(?:always|usual)\b/,
    /\b(?:mi|nuestro|el)\s+pedido\s+(?:habitual|de\s+siempre)\b/,/\blo\s+de\s+siempre\b/,
    /\b(?:ma|notre|la)\s+commande\s+habituelle\b/,/\bcomme\s+d'habitude\b/,
    /\b(?:meine|unsere|die)\s+(?:übliche|gewohnte)\s+bestellung\b/,/\bwie\s+immer\b/,
    /\b(?:il\s+mio|il\s+nostro|l')\s*ordine\s+(?:abituale|solito)\b/,/\bil\s+solito\b/,
    /\b(?:o\s+meu|o\s+nosso|o)\s+pedido\s+(?:habitual|de\s+sempre)\b/,
    /\b(?:mijn|onze|de)\s+gebruikelijke\s+bestelling\b/]]
];
// Words that ask for the repeat without changing it.
const filler=new Set(`please pls kindly can could would will you we us me i our my their his her them they it that this just do does
  repeat reorder re-order order orders send ship deliver place put make create book enter same again the a an for to of from as like
  wants want needs need would like customer customers thanks thank hi hello hey dear yes ok okay
  por favor para de del el la los las mismo misma pedido pedir manda mande envía envia enviar repite repetir repita quiere quieren cliente
  s'il vous plaît plait pour de du le les commande répète repete répéter repeter envoyez envoyer merci client veut
  bitte für fur von die der das bestellung wiederhole wiederholen schicken senden danke kunde möchte
  per favore di il lo la ordine ripeti ripetere manda mandate grazie cliente vuole
  por favor para do da o a pedido repita repetir envie enviar obrigado obrigada cliente quer
  graag voor van de het bestelling herhaal herhalen stuur sturen bedankt klant wil`.split(/\s+/).filter(Boolean));

const clean=text=>String(text||'').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();

function read(text){
  const plain=clean(text).toLowerCase();
  if(!plain||plain.length>400||/[?¿]/.test(plain))return null;
  for(const [period,patterns] of phrases)for(const pattern of patterns){
    const match=pattern.exec(plain);
    if(match)return {period,phrase:match[0],index:match.index};
  }
  return null;
}

// What is left once the phrase, the named customer and the filler words are taken out.
function leftover(text,found,names=[]){
  let plain=clean(text).toLowerCase();
  plain=plain.slice(0,found.index)+' '+plain.slice(found.index+found.phrase.length);
  for(const name of names.filter(Boolean).map(n=>clean(n).toLowerCase()).sort((a,b)=>b.length-a.length)){
    let at;while((at=plain.indexOf(name))>=0)plain=plain.slice(0,at)+' '+plain.slice(at+name.length);
  }
  return plain.replace(/'s\b/g,' ').split(/[^\p{L}\p{N}'-]+/u).map(w=>w.replace(/^['-]+|['-]+$/g,'')).filter(w=>w&&!filler.has(w));
}

// A customer email that only asks for a repeat. Greetings, a sign-off and the
// name under it may surround the sentence; quoted earlier mail is ignored.
function emailRequest(subject,body,names=[]){
  const lines=[];
  for(const raw of String(body||'').split(/\r?\n/)){
    const line=raw.trim();
    if(/^(?:>|on .{0,120}wrote:|-{2,}\s*original message|from:\s)/i.test(line))break;
    if(/^(?:thanks|thank you|many thanks|regards|best|best regards|kind regards|cheers|sincerely|gracias|saludos|merci|cordialement|danke|grüße|gruesse|grazie|saluti|obrigad[oa]|bedankt|groeten)(?:[,!.]+(?:\s*[\p{L}.'-]+){0,3})?[,!.]*$/iu.test(line))break;
    if(/^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|hola|bonjour|hallo|ciao|ol[áa]|buenos d[íi]as)(?:\s+[\p{L}.'-]+){0,3}[,!.]*$/iu.test(line))continue;
    if(line)lines.push(line);
  }
  const text=lines.length?lines.join(' '):String(subject||'').replace(/^(?:(?:re|aw|sv|fw|fwd|tr|wg):\s*)+/i,'');
  const found=read(text);
  if(!found)return null;
  return {...found,text,extra:leftover(text,found,names)};
}

module.exports={read,leftover,emailRequest,clean};
