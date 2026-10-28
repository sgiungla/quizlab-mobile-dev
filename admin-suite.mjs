const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=value=>{if(value===null||value===undefined)return'non disponibile';const n=Number(value),unit=Math.min(3,Math.floor(Math.log10(Math.max(1,n))/3));return(n/1000**unit).toLocaleString('it-IT',{maximumFractionDigits:2})+' '+['B','KB','MB','GB'][unit];};
const perfLabels={startup:'Avvio app',course_open:'Apertura materia',answer:'Conferma risposta',local_save:'Salvataggio sul dispositivo',cloud_sync:'Sincronizzazione cloud',gradebook_save:'Salvataggio libretto'},kindLabels={pwa_desktop:'App / browser su PC',pwa_mobile:'App / browser su telefono',extension_desktop:'Estensione su Pegaso'};
const count=v=>Number(v).toLocaleString('it-IT'),when=v=>v?new Date(v).toLocaleString('it-IT'):'non disponibile',duration=v=>v===null||v===undefined?'non disponibile':Number(v)>=1000?(Number(v)/1000).toLocaleString('it-IT',{maximumFractionDigits:2})+' s':Number(v).toLocaleString('it-IT',{maximumFractionDigits:0})+' ms';
export function renderPerformance(report,kind='all'){
 const rows=(report?.rows||[]).filter(r=>kind==='all'||r.kind===kind),groups=new Map();
 for(const r of rows){const v=groups.get(r.operation)||{samples:0,total:0,max:0,errors:0,slow:0,threshold:r.slow_threshold_ms};v.samples+=Number(r.samples);v.total+=Number(r.total_ms);v.max=Math.max(v.max,Number(r.max_ms));v.errors+=Number(r.errors);v.slow+=Number(r.slow_samples);groups.set(r.operation,v);}
 const latest=rows.map(r=>r.last_at).filter(Boolean).sort().at(-1),cards=Object.entries(perfLabels).map(([op,label])=>{const r=groups.get(op);return '<article class="monitor-stat"><span>'+label+'</span><strong>'+duration(r?.samples?r.total/r.samples:null)+'</strong><small>'+(r?count(r.samples)+' campioni · '+count(r.slow)+' lenti · '+count(r.errors)+' non riusciti':'In attesa delle prime misure')+'</small></article>';}).join('');
 const detail=rows.map(r=>'<tr><td>'+esc(kindLabels[r.kind]||r.kind)+'</td><td>'+esc(perfLabels[r.operation]||r.operation)+'</td><td>'+count(r.samples)+'</td><td>'+duration(r.average_ms)+'</td><td>'+duration(r.max_ms)+'</td><td>'+count(r.slow_samples)+'</td><td>'+count(r.errors)+'</td></tr>').join('');
 return '<div class="monitor-grid">'+cards+'</div><p class="subtle">Ultimo campione: '+esc(when(latest))+' · Riepilogo letto: '+esc(when(report?.observedAt))+'</p><p class="subtle">Tempi osservati sui dispositivi aggiornati, poi inviati in piccoli gruppi: possono arrivare con ritardo o dopo il ritorno online. Sono campioni, non misure di tutti gli utenti né un controllo continuo del server. La media non descrive ogni singolo utilizzo.</p><details><summary>Tempi per dispositivo e criteri</summary><p>«Lento» significa: avvio oltre 3 s; apertura materia oltre 1 s; conferma risposta e libretto oltre 700 ms; salvataggio locale oltre 500 ms; sincronizzazione oltre 5 s. Durate oltre 2 minuti escluse; massimo 1.000 campioni per operazione, dispositivo e giorno. Nessun nome, materia, testo, risposta o indirizzo viene raccolto.</p>'+(detail?'<div class="monitor-table-wrap"><table class="monitor-table"><thead><tr><th>Dispositivo</th><th>Operazione</th><th>Campioni</th><th>Media</th><th>Peggiore osservato</th><th>Lenti</th><th>Non riusciti</th></tr></thead><tbody>'+detail+'</tbody></table></div>':'<p>Nessuna misura disponibile per il periodo o dispositivo selezionato.</p>')+'</details>';
}
export function renderTraffic(traffic,days=7){
 const oldest=new Date(Date.now()-(days-1)*86400000).toISOString().slice(0,10),rows=(traffic?.rows||[]).filter(r=>String(r.day).slice(0,10)>=oldest),total=rows.reduce((t,r)=>({requests:t.requests+Number(r.requests||0),bytes:t.bytes+Number(r.response_bytes||0),db:t.db+Number(r.database_logical_bytes||0),errors:t.errors+Number(r.errors||0)}),{requests:0,bytes:0,db:0,errors:0});
 const grouped=new Map();for(const r of rows){const prev=grouped.get(r.route)||{route:r.route,requests:0,response_bytes:0,database_logical_bytes:0,errors:0};for(const k of ['requests','response_bytes','database_logical_bytes','errors'])prev[k]+=Number(r[k]||0);grouped.set(r.route,prev);}
 const top=[...grouped.values()].sort((a,b)=>b.response_bytes-a.response_bytes),summary=rows.length?'<div class="monitor-grid"><article class="monitor-stat"><span>Richieste osservate</span><strong>'+count(total.requests)+'</strong></article><article class="monitor-stat"><span>Risposte restituite all’app</span><strong>'+bytes(total.bytes)+'</strong></article><article class="monitor-stat"><span>Letture backend stimate</span><strong>'+bytes(total.db)+'</strong></article><article class="monitor-stat"><span>Richieste non riuscite</span><strong>'+count(total.errors)+'</strong></article></div>':'<p>Nessun dato di traffico disponibile nel periodo selezionato.</p>';
 return summary+'<p class="subtle">Copertura: nuovo servizio di studio e amministrazione. Esclusi vecchi client e chiamate dirette non osservate. Byte logici: non sono il consumo ufficiale Supabase; risposte e letture backend non vanno sommate per stimarlo.</p><details><summary>Operazioni più pesanti e dettagli giornalieri</summary>'+top.map(r=>'<p><strong>'+esc(r.route)+'</strong> · '+count(r.requests)+' richieste · '+bytes(r.response_bytes)+' restituiti · '+bytes(r.database_logical_bytes)+' letti dal backend (stima) · '+count(r.errors)+' errori</p>').join('')+'<details><summary>Apri i singoli giorni</summary>'+rows.map(r=>'<p>'+esc(String(r.day).slice(0,10))+' · '+esc(r.route)+' · '+count(r.requests)+' richieste · '+bytes(r.response_bytes)+' restituiti · '+bytes(r.database_logical_bytes)+' letti (stima)</p>').join('')+'</details></details><details><summary>Automazioni: ultima esecuzione</summary><p>Processo '+(traffic?.scheduler?.enabled?'attivo':'non disponibile o disattivato')+' · Ultima esecuzione: '+esc(when(traffic?.scheduler?.last_run))+'</p><p>Questo dato non certifica la consegna delle push e non misura la velocità dell’app.</p></details>';
}
export function renderStorage(storage){const row=Array.isArray(storage)?storage[0]:storage;if(!row)return '<p>Spazio occupato non disponibile.</p>';return '<div class="monitor-grid">'+[['database_bytes','Database complessivo'],['banks_table_bytes','Tabella banche'],['progress_table_bytes','Tabella progressi']].map(([key,label])=>'<article class="monitor-stat"><span>'+label+'</span><strong>'+bytes(row[key])+'</strong></article>').join('')+'</div><details><summary>Dimensioni logiche dei contenuti</summary><p>Banche domande: '+bytes(row.banks_json_bytes)+' · Progressi: '+bytes(row.progress_json_bytes)+'</p><p>Le dimensioni logiche dei JSON e quelle occupate nel database sono misure differenti: non vanno sommate fra loro o al totale. Non rappresentano traffico consumato.</p></details>';}
export function installAdminSuite(ctx){
 const $=id=>document.getElementById(id),mounted=new Map(),performanceCache=new Map();let generation=0,current='accounts',cloudLoadedAt=0,cloudRequest=null,cloudReport=null;
 const valid=id=>ctx.permitted()&&ctx.session()?.user?.id===id;
 async function api(path,body){
  const session=ctx.session(),id=session?.user?.id;if(!valid(id))throw Error('Accesso amministratore richiesto');
  const response=await fetch(globalThis.QUIZLAB_LAB_CONFIG.suiteBase+'/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+session.access_token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!valid(id))throw Error('Account cambiato');if(!response.ok)throw Error(result.message||'Servizio non disponibile');return result;
 }
 function applyTabs(){
  const enabled=ctx.permitted();for(const a of document.querySelectorAll('[data-admin-tab]'))a.setAttribute('aria-current',a.dataset.adminTab===current?'page':'false');
  $('accounts').hidden=current!=='accounts';$('plans').hidden=current!=='plans';if(current==='plans')$('plans').open=true;
  if(current!=='accounts')$('accountDetail').hidden=true;else if(enabled&&ctx.hasTarget?.())$('accountDetail').hidden=false;
  for(const section of document.querySelectorAll('[data-admin-extra]'))section.hidden=!enabled||section.dataset.adminExtra!==current;
 }
 async function cloud(force=false){
  const id=ctx.session()?.user?.id;if(!valid(id))return;
  if(cloudRequest?.id===id)return cloudRequest.promise;
  if(!force&&Date.now()-cloudLoadedAt<60000)return;cloudLoadedAt=Date.now();
  const load={id,promise:null};load.promise=(async()=>{try{
   await globalThis.QuizLabEgress.mount($('cloudEgress'),{accountId:id,isAdmin:true,currentAccount:()=>ctx.session()?.user?.id,request:async(_,body)=>{
    const r=await fetch(globalThis.QUIZLAB_LAB_CONFIG.runtimeBase+'/egress',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ctx.session().access_token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const value=await r.json();if(!valid(id))throw Error('Account cambiato');if(!r.ok)throw Error(value.message||'Lettura egress non disponibile');return value;
   }});
   const days=Number($('monitorPeriod')?.value)||7,perfKey=id+':'+days,cachedPerf=performanceCache.get(perfKey);
   const performanceRequest=!force&&cachedPerf&&Date.now()-cachedPerf.at<300000?Promise.resolve(cachedPerf.data):api('admin/performance?days='+days).then(data=>{performanceCache.set(perfKey,{at:Date.now(),data});return data;}).catch(error=>({unavailable:true,message:error.message}));
   const [traffic,storage,courses,retired,performance]=await Promise.all([api('admin/traffic'),ctx.rpc('quizlab_admin_storage_overview'),ctx.rpc('quizlab_admin_course_summary'),ctx.rpc('quizlab_admin_retired_courses'),performanceRequest]);
   if(!valid(id))return;
   cloudReport={traffic,performance};
   $('suitePerformance').innerHTML=performance.unavailable?'<p role="status">Misure delle prestazioni non disponibili: '+esc(performance.message)+'. Non significa tempo zero.</p>':renderPerformance(performance,$('monitorKind').value);
   $('suiteTraffic').innerHTML=renderTraffic(traffic,days);
   $('cloudStorage').innerHTML=renderStorage(storage);
   const render=()=>{QuizLabListNavigation.mount($('cloudCourses'),{key:id+':global-courses:'+$('cloudCourseFilter').value,rows:(courses||[]).filter(c=>String(c.subject||c.course_id).toLowerCase().includes($('cloudCourseFilter').value.toLowerCase())),renderItem:c=>'<details><summary>'+esc(c.subject||c.course_id)+' · '+Number(c.user_count||0)+' utenti</summary><p>'+Number(c.attempt_count||0)+' tentativi · '+Number(c.exam_count||0)+' simulazioni</p><button class="btn danger-btn" data-global-retire="'+esc(c.course_id)+'" data-subject="'+esc(c.subject||c.course_id)+'">Elimina dal cloud per tutti</button></details>',label:'materie cloud',searchable:false,empty:'Nessuna materia corrispondente.'});};render();$('cloudCourseFilter').oninput=render;
   QuizLabListNavigation.mount($('cloudRetired'),{key:id+':retired-courses',rows:retired||[],renderItem:c=>'<p>'+esc(c.subject||c.course_id)+' <button class="btn secondary" data-global-restore="'+esc(c.course_id)+'">Riabilita importazione</button></p>',text:c=>c.subject||c.course_id,label:'materie ritirate',empty:'Nessuna materia ritirata.'});
   $('cloudMessage').textContent='Riepiloghi aggiornati al '+when(new Date().toISOString())+'. Le misure dei dispositivi possono arrivare dopo alcuni minuti. Il consumo ufficiale Supabase resta una rilevazione manuale separata.';
  }catch(e){if(valid(id))$('cloudMessage').textContent='Aggiornamento non riuscito: '+e.message+'. Le ultime letture restano visibili con la propria data.';}
  })().finally(()=>{if(cloudRequest===load)cloudRequest=null;});cloudRequest=load;return load.promise;
 }
 async function open(){
  const stamp=++generation;current=['accounts','plans','notifications','commerce','cloud'].includes(location.hash.slice(1))?location.hash.slice(1):'accounts';applyTabs();
  if(!ctx.permitted())return;
  if(current==='cloud')return cloud();
  if(['notifications','commerce'].includes(current)){
   try{
    const key=current;
    if(!mounted.has(key)){
     const entry={ownerId:ctx.session()?.user?.id,initialRefreshAvailable:true,promise:null};
     entry.promise=(async()=>{const module=await import(key==='notifications'?'./notification-admin.js':'./commerce-admin.js');return(key==='notifications'?module.mountNotifications:module.mountCommerce)({client:ctx.client()});})().catch(e=>{if(mounted.get(key)===entry)mounted.delete(key);throw e;});
     mounted.set(key,entry);
    }
    const entry=mounted.get(key),feature=await entry.promise;
    if(stamp!==generation||!ctx.permitted())return;
    // Both modules already refresh during mounting. Consume that first result
    // once; a later opening or a different account must refresh normally.
    const initialForAccount=entry.initialRefreshAvailable&&entry.ownerId===ctx.session()?.user?.id;
    entry.initialRefreshAvailable=false;
    if(!initialForAccount)await feature.refresh();
    if(stamp!==generation||!ctx.permitted())return;applyTabs();
   }catch(e){$('adminMessage').textContent=e.message;}
  }
 }
 addEventListener('hashchange',open);addEventListener('quizlab-admin-context',()=>{cloudLoadedAt=0;open();});
 $('cloudReload').addEventListener('click',()=>cloud(true));
 $('monitorPeriod')?.addEventListener('change',()=>cloud(true));
 $('monitorKind')?.addEventListener('change',()=>{if(ctx.permitted()&&cloudReport?.performance&&!cloudReport.performance.unavailable)$('suitePerformance').innerHTML=renderPerformance(cloudReport.performance,$('monitorKind').value);});
 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-global-retire],[data-global-restore]');if(!button||!ctx.permitted())return;
  const id=ctx.session().user.id,course=button.dataset.globalRetire||button.dataset.globalRestore,retire=!!button.dataset.globalRetire;
  if(!confirm(retire?'Eliminare questa materia e tutti i suoi progressi dal cloud di tutti gli utenti? Conserva prima i backup.':'Riabilitare l’importazione? I dati cancellati non verranno ricreati.'))return;
  if(retire&&prompt('Per confermare scrivi: ELIMINA PER TUTTI')!=='ELIMINA PER TUTTI')return;
  if(!valid(id))return;button.disabled=true;
  try{await ctx.rpc(retire?'quizlab_admin_retire_course':'quizlab_admin_restore_course',{target_course_id:course});if(valid(id))await cloud(true);}catch(e){if(valid(id))$('cloudMessage').textContent=e.message;}finally{button.disabled=false;}
 });
 open();
}
