export function validateEgress(input,now=new Date()){
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!['expectedRevision','thresholds','snapshot'].includes(k)))throw Error('Campi egress non consentiti.');
  const thresholds=input.thresholds||[70,90];
  if(!Array.isArray(thresholds)||thresholds.length!==2||thresholds.some(x=>!Number.isFinite(x)||x<=0||x>=100)||thresholds[0]>=thresholds[1])throw Error('Soglie non valide: due percentuali crescenti fra 0 e 100.');
  if(input.snapshot===null||input.snapshot===undefined)return {thresholds,snapshot:null};
  const s=input.snapshot;
  if(!s||Array.isArray(s)||typeof s!=='object')throw Error('Campi egress non consentiti.');
  if(Object.keys(s).some(k=>!['usedBytes','quotaBytes','cachedUsedBytes','cachedQuotaBytes','periodStart','periodEnd','resetAt','observedAt','restricted','scope','source'].includes(k)))throw Error('Campi egress non consentiti.');
  const number=x=>x===null||x===undefined?null:Number(x);
  const out={usedBytes:number(s.usedBytes),quotaBytes:number(s.quotaBytes),cachedUsedBytes:number(s.cachedUsedBytes),cachedQuotaBytes:number(s.cachedQuotaBytes),periodStart:s.periodStart||null,periodEnd:s.periodEnd||null,resetAt:s.resetAt||null,observedAt:s.observedAt,restricted:s.restricted===true,scope:s.scope,source:s.source};
  for(const k of ['usedBytes','quotaBytes','cachedUsedBytes','cachedQuotaBytes'])if(out[k]!==null&&(!Number.isSafeInteger(out[k])||out[k]<0||k.includes('Quota')&&out[k]===0||k==='quotaBytes'&&out[k]===0))throw Error('Byte o quota non validi.');
  if(out.usedBytes===null&&out.cachedUsedBytes===null)throw Error('Inserisci almeno un consumo rilevato; i dati mancanti restano non disponibili.');
  if(!['organization','project'].includes(out.scope)||out.source!=='supabase-usage-manual')throw Error('Fonte non supportata. Usa i valori rilevati in Supabase Usage.');
  for(const k of ['periodStart','periodEnd','resetAt','observedAt'])if(out[k]!==null&&(!Number.isFinite(Date.parse(out[k]))||String(out[k]).length>40))throw Error('Data di riferimento non valida.');
  if(!out.observedAt||Date.parse(out.observedAt)>now.getTime()+60000)throw Error('Data di rilevazione mancante o futura.');
  if(out.periodStart&&out.periodEnd&&Date.parse(out.periodEnd)<=Date.parse(out.periodStart))throw Error('Periodo di riferimento non valido.');
  if(out.periodStart&&Date.parse(out.observedAt)<Date.parse(out.periodStart)||out.periodEnd&&Date.parse(out.observedAt)>Date.parse(out.periodEnd))throw Error('Rilevazione fuori dal periodo indicato.');
  return {thresholds,snapshot:out};
}
export function egressView(value,now=new Date()){
  const s=value.snapshot,used=s?.usedBytes??null,quota=s?.quotaBytes??null;
  const percent=used!==null&&quota!==null?100*used/quota:null;
  const cachedPercent=s?.cachedUsedBytes!==null&&s?.cachedUsedBytes!==undefined&&s?.cachedQuotaBytes?100*s.cachedUsedBytes/s.cachedQuotaBytes:null;
  const comparable=[percent,cachedPercent].filter(x=>x!==null),highest=comparable.length?Math.max(...comparable):null;
  const outdated=!!s&&(now.getTime()-Date.parse(s.observedAt)>86400000||s.periodEnd&&now>=new Date(s.periodEnd));
  return {...value,available:!!s,percent,cachedPercent,remainingBytes:used!==null&&quota!==null?Math.max(0,quota-used):null,outdated,
    state:s?.restricted?'restricted':highest===null?'unavailable':highest>=100?'limit':highest>=value.thresholds[0]?'warning':'normal',
    warningLevel:highest===null?null:highest>=value.thresholds[1]?'high':highest>=value.thresholds[0]?'early':null,
    source:s?'Supabase Usage — valori inseriti dall’amministratore':'Non disponibile',
    collection:'manual-dashboard-reading',automaticBillingAPI:false};
}
