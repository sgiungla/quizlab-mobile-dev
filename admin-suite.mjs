const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes=value=>{if(value===null||value===undefined)return'non disponibile';const n=Number(value),unit=Math.min(3,Math.floor(Math.log10(Math.max(1,n))/3));return(n/1000**unit).toLocaleString('it-IT',{maximumFractionDigits:2})+' '+['B','KB','MB','GB'][unit];};
export function installAdminSuite(ctx){
 const $=id=>document.getElementById(id),mounted=new Map();let generation=0,current='accounts',cloudLoadedAt=0;
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
  if(!force&&Date.now()-cloudLoadedAt<60000)return;cloudLoadedAt=Date.now();
  try{
   await globalThis.QuizLabEgress.mount($('cloudEgress'),{accountId:id,isAdmin:true,currentAccount:()=>ctx.session()?.user?.id,request:async(_,body)=>{
    const r=await fetch(globalThis.QUIZLAB_LAB_CONFIG.runtimeBase+'/egress',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ctx.session().access_token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const value=await r.json();if(!valid(id))throw Error('Account cambiato');if(!r.ok)throw Error(value.message||'Lettura egress non disponibile');return value;
   }});
   const [traffic,storage,courses,retired]=await Promise.all([api('admin/traffic'),ctx.rpc('quizlab_admin_storage_overview'),ctx.rpc('quizlab_admin_course_summary'),ctx.rpc('quizlab_admin_retired_courses')]);
   if(!valid(id))return;
   $('suiteTraffic').innerHTML='<p>Scheduler: '+(traffic.scheduler.enabled?'attivo':'in preparazione')+' · Ultima esecuzione: '+esc(traffic.scheduler.last_run?new Date(traffic.scheduler.last_run).toLocaleString('it-IT'):'non disponibile')+'</p><details><summary>Misure per giorno e operazione</summary>'+traffic.rows.map(r=>'<p>'+esc(r.day)+' · '+esc(r.route)+' · '+Number(r.requests)+' richieste · '+bytes(r.response_bytes)+' di risposte app · '+bytes(r.database_logical_bytes)+' di letture backend stimate · Ultima lettura: '+bytes(r.last_database_logical_bytes)+' · '+Number(r.errors)+' errori</p>').join('')+'</details>';
   $('cloudStorage').innerHTML='<pre>'+esc(JSON.stringify(storage,null,2))+'</pre>';
   const render=()=>{$('cloudCourses').innerHTML=(courses||[]).filter(c=>String(c.subject||c.course_id).toLowerCase().includes($('cloudCourseFilter').value.toLowerCase())).map(c=>'<details><summary>'+esc(c.subject||c.course_id)+' · '+Number(c.user_count||0)+' utenti</summary><p>'+Number(c.attempt_count||0)+' tentativi · '+Number(c.exam_count||0)+' simulazioni</p><button class="btn danger-btn" data-global-retire="'+esc(c.course_id)+'" data-subject="'+esc(c.subject||c.course_id)+'">Elimina dal cloud per tutti</button></details>').join('')||'<p>Nessuna materia corrispondente.</p>';};render();$('cloudCourseFilter').oninput=render;
   $('cloudRetired').innerHTML=(retired||[]).map(c=>'<p>'+esc(c.subject||c.course_id)+' <button class="btn secondary" data-global-restore="'+esc(c.course_id)+'">Riabilita importazione</button></p>').join('')||'<p>Nessuna materia ritirata.</p>';
   $('cloudMessage').textContent='Monitor aggiornato. La data della lettura ufficiale è indicata nella sezione egress.';
  }catch(e){if(valid(id))$('cloudMessage').textContent='Aggiornamento non riuscito: '+e.message+'. Le ultime letture restano visibili con la propria data.';}
 }
 async function open(){
  const stamp=++generation;current=['accounts','plans','notifications','commerce','cloud'].includes(location.hash.slice(1))?location.hash.slice(1):'accounts';applyTabs();
  if(!ctx.permitted())return;
  if(current==='cloud')return cloud();
  if(['notifications','commerce'].includes(current)){
   try{
    const key=current;if(!mounted.has(key))mounted.set(key,(async()=>{const module=await import(key==='notifications'?'./notification-admin.js':'./commerce-admin.js');return(key==='notifications'?module.mountNotifications:module.mountCommerce)({client:ctx.client()});})().catch(e=>{mounted.delete(key);throw e;}));
    const feature=await mounted.get(key);if(stamp!==generation||!ctx.permitted())return;await feature.refresh();applyTabs();
   }catch(e){$('adminMessage').textContent=e.message;}
  }
 }
 addEventListener('hashchange',open);addEventListener('quizlab-admin-context',()=>{cloudLoadedAt=0;open();});
 $('cloudReload').addEventListener('click',()=>cloud(true));
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
