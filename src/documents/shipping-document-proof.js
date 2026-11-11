'use strict';

const kinds={bill_of_lading:'Bill of lading',customs:'Customs papers'};
const titles={
  bill_of_lading:/^(?:bill of lading|(?:ocean|house|master|straight|multimodal|through|combined transport) bill of lading|connaissement(?: maritime)?|conocimiento de embarque|konnossement|polizza di carico)(?=$|[\s:,(–—-])/iu,
  customs:/^(?:customs (?:declaration|entry|clearance|papers?|document|manifest)|(?:import|export) declaration|single administrative document|entry summary|déclaration (?:en douane|douanière|d'importation|d'exportation)|declaración (?:aduanera|de importación|de exportación)|zollanmeldung)(?=$|[\s:,(–—-])/iu,
};
const unrelated=/^(?:commercial invoice|tax invoice|invoice|packing list|safety data sheet)\s*$/iu;
const poLabel=/^(?:buyer(?:'s)?\s+)?(?:p\.?\s*o\.?|purchase\s+orders?|purchasing\s+orders?|bon\s+de\s+commande|commande\s+d['’]achat|orden(?:es)?\s+de\s+compra|bestell(?:nummer|referenz)|ordine\s+d['’]acquisto)(?:\s+(?:numbers?|no\.?|codes?|refs?\.?|references?|n°|nummer))?\s*(?:(?:[:=#|]\s*)|\s+|$)(.*)$/iu;
const poToken=/^[\p{L}\p{N}][\p{L}\p{N}._/\-]{0,119}$/u;
const fieldLabels={
  document_number:/^(?:(?:bill of lading|b\/?l|connaissement|customs entry|declaration|déclaration)\s+(?:number|no\.?|reference|id)|mrn)\s*[:=#|]\s*(.+)$/iu,
  container:/^(?:containers?(?:\s+(?:number|no\.?|code|id))?|conteneur|contenedor)\s*[:=#|]\s*(.+)$/iu,
  vessel:/^(?:vessel|voyage|vessel and voyage|navire|buque)\s*[:=|]\s*(.+)$/iu,
  carrier:/^(?:carrier|shipping line|transporteur|transportista)\s*[:=|]\s*(.+)$/iu,
  shipper:/^(?:shipper|exporter|consignor|expéditeur|exportateur)\s*[:=|]\s*(.+)$/iu,
  consignee:/^(?:consignee|importer|destinataire|importateur)\s*[:=|]\s*(.+)$/iu,
  port_of_loading:/^(?:port of loading|port de chargement|puerto de carga)\s*[:=|]\s*(.+)$/iu,
  port_of_discharge:/^(?:port of discharge|port de déchargement|puerto de descarga)\s*[:=|]\s*(.+)$/iu,
  shipment_date:/^(?:shipment date|on board date|date of shipment|date d'expédition)\s*[:=|]\s*(.+)$/iu,
  customs_reference:/^(?:customs reference|customs entry|entry number|declaration reference|référence douanière)\s*[:=#|]\s*(.+)$/iu,
  tariff:/^(?:hs code|tariff code|commodity code|customs classification)\s*[:=|]\s*(.+)$/iu,
};
const labels={document_number:'Document reference',container:'Container',vessel:'Vessel or voyage',carrier:'Carrier',shipper:'Shipper or exporter',consignee:'Consignee or importer',port_of_loading:'Port of loading',port_of_discharge:'Port of discharge',shipment_date:'Shipment date',customs_reference:'Customs reference',tariff:'Printed tariff or commodity code'};
const uncertainSection=page=>page.requiresSourceConfirmation||page.sourceKind==='scan'||/comments|footnotes|endnotes/i.test(page.sourceName||'')||/\[(?:Tracked deletion|Struck-out text)/.test(page.text);
const normalized=s=>String(s).trim().toLowerCase();

function referenceValues(value){
  const parts=String(value).split(/[,;|]/u).map(s=>s.trim()).filter(Boolean);
  if(parts.every(p=>poToken.test(p)))return parts;
  return [];
}

function inspect(pages){
  const headings=[],other=[],references=[],fields=[],issues=[];
  for(const page of pages){
    const rows=page.text.split(/\r?\n/u).map(s=>s.trim());
    const at=(quote,value)=>({page:page.page,sourceKind:page.sourceKind,sourceName:page.sourceName||'',quote,value,
      uncertain:uncertainSection(page)||page.sourceKind==='mixed'&&!page.nativeText?.includes(quote)});
    for(let i=0;i<rows.length;i++){
      const line=rows[i];if(!line)continue;
      for(const [kind,pattern] of Object.entries(titles))if(pattern.test(line)&&!/(?:\b(?:number|no\.?|reference)\s*[:#=]|\bnot a\b)/iu.test(line))headings.push({...at(line,line),kind});
      if(unrelated.test(line))other.push(at(line,line));
      const marked=poLabel.exec(line);
      if(marked){
        let value=marked[1].trim(),quote=line;
        if(!value){const next=rows[i+1]?.trim();if(next&&referenceValues(next).length){value=next;quote=line+'\n'+next;}}
        const values=referenceValues(value);
        if(values.length)for(const reference of values)references.push(at(quote,reference));
        else issues.push({page:page.page,quote:line,reason:'This purchase order reference needs an exact owner check.'});
      }
      for(const [kind,pattern] of Object.entries(fieldLabels)){
        const match=pattern.exec(line);
        if(match)fields.push({...at(line,match[1]),kind});
      }
    }
  }
  const types=[...new Set(headings.map(row=>row.kind))];
  const kind=types.length===1?types[0]:null;
  if(types.length&&other.length)issues.push({reason:'This original also contains another business document type. Check the intended shipping evidence before filing.'});
  if(types.length>1)issues.push({reason:'The original contains more than one shipping document type. Confirm how it belongs on the PO.'});
  if(!types.length&&other.length)issues.push({reason:'The original identifies a different business document type. Use its matching filing workflow.'});
  if(!types.length&&!other.length)issues.push({reason:'Check whether this original is a bill of lading or customs document.'});
  const unique=new Map();
  for(const ref of references){
    const key=normalized(ref.value),earlier=unique.get(key);
    if(!earlier||earlier.uncertain&&!ref.uncertain)unique.set(key,ref);
  }
  if(!unique.size)issues.push({reason:'The original did not establish an exact labelled purchase order number.'});
  return {kind,headings,referenceEvidence:references,references:[...unique.values()],fields,issues,unrelated:!types.length&&other.length>0};
}

const hasPoLabel=line=>poLabel.test(line);
module.exports={kinds,labels,inspect,normalized,poToken,hasPoLabel};
