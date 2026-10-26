(() => {
  'use strict';
  const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const gb=x=>x===null||x===undefined?'non disponibile':(x/1e9).toLocaleString('it-IT',{maximumFractionDigits:3})+' GB';
  const date=x=>x?new Date(x).toLocaleString('it-IT'):'non disponibile';
  const cache=new Map();
  const key=id=>'quizlab.admin.egress.v1.'+id;
  function readCache(id){try{return JSON.parse(localStorage.getItem(key(id))||'null');}catch{return null;}}
  function html(data,{cached=false,localOnly=false}={}){
    const d=data||{snapshot:null,thresholds:[70,90]},s=d.snapshot;
    const states={normal:'Normale',warning:'Attenzione',limit:'Limite raggiunto',restricted:'Servizio limitato',unavailable:'Non disponibile'};
    return `<h3>Traffico in uscita / Egress Supabase</h3><p>Stato all’ultima lettura: ${escape(states[d.state]||'Non disponibile')}${cached?' · Ultima lettura conservata in cache':''}${d.outdated?' · Rilevazione da aggiornare':''}</p><p>Consumo non in cache: <strong>${gb(s?.usedBytes)}</strong> · Quota: ${gb(s?.quotaBytes)} · Utilizzo: ${d.percent===null||d.percent===undefined?'non disponibile':d.percent.toFixed(1)+'%'} · Residuo: ${gb(d.remainingBytes)}</p><p>Consumo in cache: ${gb(s?.cachedUsedBytes)} · Quota in cache: ${gb(s?.cachedQuotaBytes)}</p>${d.warningLevel==='high'?'<p><strong>Avviso elevato: quota vicina al limite.</strong></p>':d.warningLevel==='early'?'<p>Primo avviso: controlla il consumo prima del limite.</p>':''}<p>Periodo: ${date(s?.periodStart)} — ${date(s?.periodEnd)} · Reset: ${date(s?.resetAt)}</p><p>Rilevato: ${date(s?.observedAt)} · Fonte: ${escape(d.source||'Non disponibile')} · Ambito: ${s?.scope==='organization'?'organizzazione':s?.scope==='project'?'progetto':'non disponibile'}</p>${s?.scope==='project'?'<p>Questo valore copre solo il progetto selezionato e non indica il residuo dell’intera organizzazione.</p>':''}<p>Le quote Free pubblicate sono 5 GB non in cache e 5 GB in cache, separate. Usa la quota effettiva mostrata per l’ambito scelto. Il reset non coincide necessariamente con il primo del mese.</p><a href="https://supabase.com/docs/guides/platform/manage-your-usage/egress" target="_blank" rel="noopener noreferrer">Come leggere Supabase Usage</a>${localOnly?'':`<details><summary>Aggiorna lettura e soglie</summary><p>Trascrivi i valori della dashboard Supabase. Questo inserimento non è una lettura automatica ufficiale. Lascia vuoti i valori non disponibili.</p><form data-egress-form><label>Ambito <select name="scope"><option value="organization">Organizzazione</option><option value="project">Progetto</option></select></label>${[['used','Consumo non in cache (GB)'],['quota','Quota non in cache (GB)'],['cachedUsed','Consumo in cache (GB)'],['cachedQuota','Quota in cache (GB)']].map(([n,l])=>`<label>${l}<input name="${n}" type="number" min="0" step="0.001"></label>`).join('')}${[['start','Inizio periodo'],['end','Fine periodo'],['reset','Data reset'],['observed','Data della rilevazione']].map(([n,l])=>`<label>${l}<input name="${n}" type="datetime-local" ${n==='observed'?'required':''}></label>`).join('')}<label><input name="restricted" type="checkbox">Servizio limitato, come indicato da Supabase</label><label>Primo avviso (%) <input name="early" type="number" min="1" max="99" value="${Number(d.thresholds[0])}"></label><label>Secondo avviso (%) <input name="high" type="number" min="1" max="99" value="${Number(d.thresholds[1])}"></label><button type="submit" class="btn ql-btn">Salva lettura e soglie</button></form></details><button type="button" class="btn ql-btn" data-egress-refresh>Rileggi valori conservati</button>`}<p data-egress-status role="status"></p>`;
  }
  async function mount(host,options){
    if(!host||options.isAdmin!==true)return;
    const id=options.accountId,valid=()=>options.currentAccount()===id&&host.isConnected!==false;
    let data=readCache(id),cached=!!data;host.innerHTML=html(data,{cached,localOnly:options.localOnly});
    async function load(){
      if(options.localOnly)return;
      const old=cache.get(id);
      try{data=old&&Date.now()-old.at<300000?old.data:await options.request('egress');if(!valid())return;cache.set(id,{data,at:Date.now()});localStorage.setItem(key(id),JSON.stringify(data));cached=false;draw();}
      catch{if(valid()){cached=!!data;draw();host.querySelector('[data-egress-status]').textContent='Lettura non aggiornata: cloud non disponibile. I valori conservati mantengono la data originaria.';}}
    }
    function draw(){if(!valid())return;host.innerHTML=html(data,{cached,localOnly:options.localOnly});
      host.querySelector('[data-egress-refresh]')?.addEventListener('click',load);
      host.querySelector('[data-egress-form]')?.addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
        try{const f=new FormData(form),bytes=n=>f.get(n)===''?null:Math.round(Number(f.get(n))*1e9),iso=n=>f.get(n)?new Date(f.get(n)).toISOString():null;
          const payload={expectedRevision:data?.revision||0,thresholds:[Number(f.get('early')),Number(f.get('high'))],snapshot:f.get('used')===''&&f.get('cachedUsed')===''?(data?.snapshot||null):{usedBytes:bytes('used'),quotaBytes:bytes('quota'),cachedUsedBytes:bytes('cachedUsed'),cachedQuotaBytes:bytes('cachedQuota'),periodStart:iso('start'),periodEnd:iso('end'),resetAt:iso('reset'),observedAt:iso('observed'),restricted:f.get('restricted')==='on',scope:f.get('scope'),source:'supabase-usage-manual'}};
          if(!confirm('Confermi questa lettura della dashboard Supabase? Non saranno modificati piano o dati del provider.'))return;
          const next=await options.request('egress',payload);if(!valid())return;data=next;cache.set(id,{data,at:Date.now()});localStorage.setItem(key(id),JSON.stringify(data));cached=false;draw();
        }catch(error){if(valid())host.querySelector('[data-egress-status]').textContent=error.message;}finally{button.disabled=false;}});
    }
    draw();await load();
    if(options.traffic){try{const report=await options.traffic();if(valid()&&report){const p=document.createElement('p');p.textContent='Stima applicativa di questo dispositivo: '+gb(report.responseBytes)+' di corpi risposta JSON/testo osservati, '+report.requests+' richieste, periodo UTC '+report.period+'. Non è l’egress ufficiale Supabase; esclude compressione, intestazioni, altri dispositivi e servizi non osservati.';host.appendChild(p);}}catch{}}
  }
  globalThis.QuizLabEgress={mount,html};
})();
