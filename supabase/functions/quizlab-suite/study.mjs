import {createHash,randomUUID} from 'node:crypto';
const sendLabPush=()=>{throw Error('Server push transport required');};

import {CAMPAIGN_FIELDS,campaignVariables} from './webapp/campaign-template-fields.js';
import {resolveCampaignTemplate} from './campaign-templates.mjs';
import './webapp/study-core.js';
const core=globalThis.QuizLabStudyCore;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(v,max=160)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u0008]/.test(v))throw fail(400,'Testo mancante o troppo lungo');return v.trim();};
const uuid=v=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v||''))throw fail(400,'Identificativo non valido');return v;};
const num=(v,min,max)=>{if(!Number.isFinite(v)||v<min||v>max)throw fail(400,'Valore fuori intervallo');return v;};
const date=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw fail(400,'Data non valida');return v;};
const categories=['study','progress','service','marketing'];
const variables=CAMPAIGN_FIELDS.map(f=>f.key);
const destination=v=>{if(!/^\.\/(?:\?|$)/.test(v||'')||v.length>500||/[<>\r\n#]/.test(v))throw fail(400,'Destinazione non consentita: scegli una funzione QuizLab');const u=new URL(v,'https://quizlab.example/');if([...u.searchParams.keys()].some(k=>!['study','course'].includes(k))||u.searchParams.has('study')&&!['goals','exams','inbox','preferences','review','badges'].includes(u.searchParams.get('study')))throw fail(400,'Funzione QuizLab non valida');return v;};
export const AUTOMATIONS={
 goal_reminder:{category:'study',enabled:true,title:'Il tuo obiettivo',message:'Riprendi il tuo obiettivo: {obiettivo}.',priority:1,frequencyDays:1,thresholds:[50,75,90,100],dailyLimit:2},
 goal_progress:{category:'progress',enabled:true,title:'Un passo avanti',message:'Hai raggiunto una nuova tappa del tuo obiettivo: {obiettivo}.',priority:1,frequencyDays:1,thresholds:[50,75,90,100],dailyLimit:2},
 goal_deadline:{category:'study',enabled:true,title:'La scadenza del tuo obiettivo',message:'Mancano {giorni_obiettivo} giorni alla scadenza di {obiettivo}.',priority:2,frequencyDays:1,intervals:[7,3,1],dailyLimit:2},
 review:{category:'study',enabled:true,title:'Un momento di ripasso',message:'Hai domande da ripassare in {nome_materia}.',priority:1,frequencyDays:1,dailyLimit:2},
 exam:{category:'study',enabled:true,title:'Il tuo prossimo esame',message:'Mancano {giorni_esame} giorni all’esame di {nome_materia}.',priority:2,frequencyDays:1,intervals:[30,14,7,3,1],dailyLimit:2},
 inactivity:{category:'study',enabled:true,title:'Riprendiamo lo studio?',message:'Quando vuoi, puoi riprendere con qualche domanda.',priority:1,frequencyDays:3,dailyLimit:2},
 badge:{category:'progress',enabled:true,title:'Traguardo raggiunto',message:'Hai ottenuto il riconoscimento: {traguardo}.',priority:1,frequencyDays:1,dailyLimit:2},
 bank_update:{category:'service',enabled:true,title:'Materia aggiornata',message:'La banca di {nome_materia} è stata aggiornata.',priority:1,frequencyDays:1,dailyLimit:2}
};
export function validatePreferences(raw){
 const p={...core.defaults(),...raw,categories:{...core.defaults().categories,...raw?.categories}};
 for(const key of ['pushEnabled','showPushContent','marketingConsent','countdowns'])if(typeof p[key]!=='boolean')throw fail(400,'Preferenza non valida');
 for(const key of categories)if(typeof p.categories[key]!=='boolean')throw fail(400,'Categoria non valida');
 for(const key of ['reminderTime','quietStart','quietEnd'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key]))throw fail(400,'Orario non valido');
 try{core.localParts(new Date(),p.timeZone);}catch{throw fail(400,'Fuso orario non valido');}
 if(![0,1,3,5,7,14].includes(p.inactivityDays)||!Array.isArray(p.studyDays)||p.studyDays.length>7||p.studyDays.some(x=>!Number.isInteger(x)||x<0||x>6))throw fail(400,'Giorni non validi');
 if(!Array.isArray(p.courseIds)||p.courseIds.length>200||p.courseIds.some(x=>typeof x!=='string'||!x||x.length>256))throw fail(400,'Materie non valide');
 p.categories.marketing=p.categories.marketing&&p.marketingConsent;
 return Object.fromEntries(Object.keys(core.defaults()).map(k=>[k,k==='studyDays'?[...new Set(p[k])]:p[k]]));
}
function template(t,values){return t.replace(/\{([a-z_]+)\}/g,(_,key)=>{if(!variables.includes(key)||values[key]===undefined)throw fail(400,'Variabile mancante: '+key);return String(values[key]);});}
function validateTemplate(t){text(t,1200);for(const match of t.matchAll(/\{([^}]+)\}/g))if(!variables.includes(match[1]))throw fail(400,'Variabile template non consentita: '+match[1]);if(/[{}]/.test(t.replace(/\{[a-z_]+\}/g,'')))throw fail(400,'Variabile template incompleta');return t;}
function endpointAllowed(endpoint){try{const u=new URL(endpoint);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(u.hostname)||/^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname));}catch{return false;}}
function pushFailureDescription(error,statusCode){
 if(statusCode)return 'Risposta provider '+statusCode;
 // Do not persist error bodies, subscription URLs, keys or arbitrary messages.
 const safeCodes=new Set(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UND_ERR_CONNECT_TIMEOUT']);
 const candidate=error?.code||error?.cause?.code;
 const diagnostic=safeCodes.has(candidate)?candidate:/^(?:Socket )?timeout$/i.test(error?.message||'')?'ETIMEDOUT':/vapidDetails|p256dh|publicKey|privateKey/.test(error?.message||'')?'PUSH_CONFIGURATION':['TypeError','RangeError'].includes(error?.name)?error.name:'TRANSPORT_UNKNOWN';
 const phases={configuration:'preparazione richiesta',dns:'risoluzione DNS',connect:'connessione TCP',tls:'negoziazione TLS',provider:'attesa risposta provider',response:'lettura risposta provider'};
 const detail=error?.pushDiagnostic,phase=Object.hasOwn(phases,detail?.phase||'')?phases[detail.phase]:null;
 const elapsed=Number.isInteger(detail?.elapsedMs)&&detail.elapsedMs>=0&&detail.elapsedMs<=600000?detail.elapsedMs:null;
 return 'Esito incerto; nessun reinvio automatico. Diagnostica: '+diagnostic+(phase?' · Fase: '+phase:'')+(phase&&elapsed!==null?' · '+elapsed+' ms':'');
}
export function createStudyModule({lab,vapid,allowRealPush=false,sendPush,clock=()=>new Date()}){
 const db=lab.db;let tickPromise=null,cursor=0;
 async function directoryUsers(){return(await db.query('select id,email from auth.users order by id limit 1000')).rows;}
 async function knownUser(id){return /^[0-9a-f-]{36}$/i.test(id||'')&&(await db.query('select 1 from auth.users where id=$1',[id])).rows.length>0;}
 async function admin(user){if(!await lab.rpc(user,'quizlab_is_admin'))throw fail(403,'Amministratore richiesto');}
 async function access(user){const license=await lab.rpc(user,'quizlab_license_status');return{license,study:license.status==='active'&&(license.modules?.quizlab_pwa||license.modules?.quizlab_desktop)};}
 async function requireStudy(user){if(!(await access(user)).study)throw fail(403,'Accesso QuizLab non disponibile. Dati conservati.');}
 async function prefs(user){const row=(await db.query('select revision,settings,updated_at from public.quizlab_notification_preferences where user_id=$1',[user])).rows[0];return row?{...row,settings:validatePreferences(row.settings)}:{revision:0,settings:core.defaults(),updated_at:null};}
 async function audit(user,action,detail){await db.query('insert into public.quizlab_notification_audit(actor_id,action,detail) values($1,$2,$3::jsonb)',[user,action,JSON.stringify(detail)]);}
 async function mutate(user,input,operation){
  uuid(input.request_id);const fingerprint=hash(input);
  return db.transaction(async tx=>{
   await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+input.request_id]);
   const prior=(await tx.query('select * from public.quizlab_study_requests where user_id=$1 and request_id=$2',[user,input.request_id])).rows[0];
   if(prior){if(prior.fingerprint!==fingerprint)throw fail(409,'Richiesta già usata per una modifica diversa');return prior.result;}
   const result=await operation(tx);await tx.query('insert into public.quizlab_study_requests(user_id,request_id,fingerprint,result) values($1,$2,$3,$4::jsonb)',[user,input.request_id,fingerprint,JSON.stringify(result)]);return result;
  });
 }
 async function savePreferences(user,input){
  const settings=validatePreferences(input.settings);
  return mutate(user,input,async tx=>{
   const old=(await tx.query('select * from public.quizlab_notification_preferences where user_id=$1 for update',[user])).rows[0];
   if(Number(input.expected_revision)!==Number(old?.revision||0))throw fail(409,'Preferenze cambiate su un altro dispositivo: ricarica e verifica le scelte');
   const result=(await tx.query('insert into public.quizlab_notification_preferences(user_id,settings) values($1,$2::jsonb) on conflict(user_id) do update set settings=excluded.settings,revision=quizlab_notification_preferences.revision+1,updated_at=now() returning revision,settings,updated_at',[user,JSON.stringify(settings)])).rows[0];
   await tx.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,\'preferences\',$2::jsonb)',[user,JSON.stringify({before:old?.settings||core.defaults(),after:settings})]);return result;
  });
 }
 async function snapshot(user){
  const preference=await prefs(user),now=clock();
  const metadata=(await db.query(`select b.id,b.course_id,b.subject,b.bank_revision,b.updated_at as bank_at,p.revision,p.updated_at
    from public.quizlab_banks b left join public.quizlab_user_courses p on p.bank_id=b.id and p.user_id=$1
    where b.owner_id=$1 and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=b.course_id)
    and not exists(select 1 from public.quizlab_user_deleted_courses d where d.user_id=$1 and d.course_id=b.course_id) order by b.id`,[user])).rows;
  const signature=hash({metadata,timeZone:preference.settings.timeZone,minute:Math.floor(now.getTime()/60000)});
  const cached=(await db.query('select signature,data from quizlab_release_private.suite_study_cache where user_id=$1',[user])).rows[0];
  let data;
  if(cached?.signature===signature)data=cached.data;
  else {
   // Explanations, options and source documents never leave Postgres for a study summary.
   const rows=(await db.query(`select b.course_id,b.subject,b.bank_revision,b.updated_at as bank_at,p.revision,p.updated_at,
    jsonb_build_object('officialBank',coalesce((select jsonb_agg(jsonb_build_object('id',q->'id')) from jsonb_array_elements(coalesce(b.bank_json->'officialBank','[]'::jsonb)) q),'[]'::jsonb),
     'aiBank',coalesce((select jsonb_agg(jsonb_build_object('id',q->'id')) from jsonb_array_elements(coalesce(b.bank_json->'aiBank','[]'::jsonb)) q),'[]'::jsonb)) as bank_json,
    jsonb_build_object('attempts',coalesce(p.progress_json->'attempts','[]'::jsonb),'exams',coalesce(p.progress_json->'exams','[]'::jsonb),
     'pendingReview',coalesce(p.progress_json->'pendingReview','[]'::jsonb),'syncMeta',coalesce(p.progress_json->'syncMeta','{}'::jsonb)) as progress_json
    from public.quizlab_banks b left join public.quizlab_user_courses p on p.bank_id=b.id and p.user_id=$1
    where b.id=any($2::uuid[]) order by b.id`,[user,metadata.map(r=>r.id)])).rows;
   data=core.summarize(rows,now,preference.settings.timeZone);
   data.consolidatedAt=rows.reduce((m,r)=>r.updated_at&&new Date(r.updated_at).toISOString()>m?new Date(r.updated_at).toISOString():m,'');
   await db.query('insert into quizlab_release_private.suite_study_cache(user_id,signature,data) values($1,$2,$3::jsonb) on conflict(user_id) do update set signature=excluded.signature,data=excluded.data,consolidated_at=now()',[user,signature,JSON.stringify(data)]);
  }
  const known=(await db.query('select client_id from public.quizlab_devices where user_id=$1',[user])).rows;
  const devices=(await db.query('select device_id,clean,last_seen,active_until from public.quizlab_notification_devices where user_id=$1',[user])).rows;
  data.fresh=devices.length>0&&devices.every(d=>d.clean&&clock()-new Date(d.last_seen)>=0&&clock()-new Date(d.last_seen)<120000)&&known.every(k=>devices.some(d=>d.device_id===k.client_id));
  data.active=devices.some(d=>d.active_until&&new Date(d.active_until)>clock());
  return data;
 }
 async function items(user,kind){return(await db.query('select item_id,kind,revision,data,updated_at from public.quizlab_study_items where user_id=$1 and not deleted'+(kind?' and kind=$2':'')+' order by updated_at desc',kind?[user,kind]:[user])).rows;}
 async function saveItem(user,input){
  await requireStudy(user);uuid(input.item_id);if(!['goal','exam'].includes(input.kind))throw fail(400,'Tipo non valido');
  const data=input.data||{},snap=await snapshot(user);
  if(data.courseId&&!snap.courses.some(c=>c.courseId===data.courseId))throw fail(400,'Materia non disponibile nel tuo account');
  let cleaned;
  if(input.kind==='goal'){
   if(!['unique','attempts','correct','coverage','officialCoverage','accuracy','examAverage','recovery','streak'].includes(data.metric)||!['daily','weekly','custom'].includes(data.period))throw fail(400,'Obiettivo non valido');
   cleaned={title:text(data.title),courseId:data.courseId||null,metric:data.metric,period:data.period,target:num(Number(data.target),1,['accuracy','coverage','officialCoverage'].includes(data.metric)?100:data.metric==='examAverage'?30:100000),
    startDate:data.startDate?date(data.startDate):core.localParts(clock(),(await prefs(user)).settings.timeZone).day,deadline:data.deadline?date(data.deadline):null,
    minSample:data.metric==='accuracy'?num(Number(data.minSample||30),30,100000):data.metric==='examAverage'?num(Number(data.minSample||3),3,5):1,paused:!!data.paused};
   if(cleaned.deadline&&cleaned.deadline<cleaned.startDate)throw fail(400,'Scadenza precedente all’inizio');
   if(data.metric==='recovery')cleaned.baseline=snap.courses.filter(c=>!data.courseId||c.courseId===data.courseId).flatMap(c=>c.pending.map(q=>c.courseId+'\u0000'+q));
  }else{
   if(!data.courseId)throw fail(400,'Seleziona la materia dell’esame');
   if(data.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time))throw fail(400,'Ora non valida');
   cleaned={courseId:data.courseId,date:date(data.date),time:data.time||null,preparation:text(data.preparation||'Prepararmi per l’esame',300),cancelled:!!data.cancelled};
  }
  return mutate(user,input,async tx=>{
   const old=(await tx.query('select * from public.quizlab_study_items where item_id=$1 for update',[input.item_id])).rows[0];
   if(!old&&(await tx.query('select count(*)::integer as n from public.quizlab_study_items where user_id=$1 and not deleted',[user])).rows[0].n>=500)throw fail(400,'Limite di 500 obiettivi ed esami attivi raggiunto');
   if(old&&(old.user_id!==user||old.kind!==input.kind))throw fail(403,'Elemento non disponibile');
   if(Number(input.expected_revision)!==Number(old?.revision||0))throw fail(409,'Elemento cambiato: ricarica prima di modificarlo');
   if(old?.data?.baseline&&old.data.metric===cleaned.metric&&old.data.courseId===cleaned.courseId)cleaned.baseline=old.data.baseline;
   if(cleaned.metric==='recovery'&&!cleaned.baseline.length&&!input.deleted)throw fail(400,'Non ci sono errori da recuperare nella materia selezionata');
   const row=(await tx.query('insert into public.quizlab_study_items(item_id,user_id,kind,data,deleted) values($1,$2,$3,$4::jsonb,$5) on conflict(item_id) do update set data=excluded.data,deleted=excluded.deleted,revision=quizlab_study_items.revision+1,updated_at=now() returning *',[input.item_id,user,input.kind,JSON.stringify(cleaned),!!input.deleted])).rows[0];
   await tx.query("update public.quizlab_notifications set state='cancelled' where user_id=$1 and state in ('queued','ready') and context->>'itemId'=$2",[user,input.item_id]);return row;
  });
 }
 async function registerDevice(user,input){
  const device=text(input.device_id,120),label=text(input.label||'Browser',80),permission=input.permission;
  if(!['default','granted','denied','unsupported'].includes(permission))throw fail(400,'Permesso non valido');
  let subscription=input.subscription||null,endpointHash=null;
  if(subscription){if(!endpointAllowed(subscription.endpoint)||!/^[A-Za-z0-9_-]{87}$/.test(subscription.keys?.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(subscription.keys?.auth||''))throw fail(400,'Sottoscrizione push non valida');endpointHash=hash(subscription.endpoint);subscription={endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth}};}
  const old=(await db.query('select user_id from public.quizlab_notification_devices where endpoint_hash=$1',[endpointHash])).rows[0];if(old&&old.user_id!==user)throw fail(409,'Dispositivo associato a un altro account: disabilita prima le push su quell’account');
  await db.query(`insert into public.quizlab_notification_devices(user_id,device_id,label,permission,subscription,endpoint_hash,enabled,last_seen)values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
   on conflict(user_id,device_id)do update set label=excluded.label,permission=excluded.permission,subscription=excluded.subscription,endpoint_hash=excluded.endpoint_hash,enabled=excluded.enabled,last_seen=excluded.last_seen`,[user,device,label,permission,JSON.stringify(subscription),endpointHash,!!subscription&&permission==='granted',clock()]);
  return{ok:true};
 }
 async function heartbeat(user,input){
  const id=text(input.device_id,120);await db.query(`insert into public.quizlab_notification_devices(user_id,device_id,label,permission,clean,active_until,last_seen) values($1,$2,'Dispositivo QuizLab','default',$3,$4,$5)
   on conflict(user_id,device_id)do update set clean=excluded.clean,active_until=excluded.active_until,last_seen=excluded.last_seen`,[user,id,input.clean===true,input.active===true?new Date(clock().getTime()+90000):null,clock()]);return{ok:true};
 }
 async function listDevices(user){return(await db.query('select device_id,label,enabled,permission,last_seen from public.quizlab_notification_devices where user_id=$1 order by last_seen desc limit 50',[user])).rows;}
 async function revokeDevice(user,input){await db.query('update public.quizlab_notification_devices set enabled=false,subscription=null,endpoint_hash=null,clean=false where user_id=$1 and device_id=$2',[user,text(input.device_id,120)]);return{ok:true};}
 async function automationRows(){const saved=(await db.query('select * from public.quizlab_notification_automations')).rows;return Object.entries(AUTOMATIONS).map(([automation_id,config])=>{const old=saved.find(r=>r.automation_id===automation_id);return{automation_id,revision:old?.revision||0,config:{...config,...old?.config}};});}
 async function saveAutomation(user,input){
  await admin(user);if(!AUTOMATIONS[input.automation_id])throw fail(400,'Automazione sconosciuta');
  const base=AUTOMATIONS[input.automation_id],v=input.config||{};if(typeof v.enabled!=='boolean')throw fail(400,'Attivazione non valida');
  const config={...base,enabled:v.enabled,title:validateTemplate(text(v.title,120)),message:validateTemplate(text(v.message,1000)),priority:num(Number(v.priority),0,3),frequencyDays:num(Number(v.frequencyDays),1,30),dailyLimit:num(Number(v.dailyLimit),0,2)};
  if(base.intervals){if(!Array.isArray(v.intervals)||v.intervals.length>10||v.intervals.some(x=>!Number.isInteger(x)||x<1||x>365))throw fail(400,'Intervalli non validi');config.intervals=[...new Set(v.intervals)].sort((a,b)=>b-a);}
  if(base.thresholds){if(!Array.isArray(v.thresholds)||v.thresholds.length>10||v.thresholds.some(x=>!Number.isInteger(x)||x<1||x>100))throw fail(400,'Soglie non valide');config.thresholds=[...new Set(v.thresholds)].sort((a,b)=>a-b);}
  for(const t of [config.title,config.message])for(const m of t.matchAll(/\{([a-z_]+)\}/g))if(!{goal_reminder:['obiettivo','nome_utente'],goal_progress:['obiettivo','nome_utente'],goal_deadline:['obiettivo','nome_utente','giorni_obiettivo'],review:['nome_materia','nome_utente','domande_da_ripassare'],exam:['nome_materia','nome_utente','giorni_esame','percentuale_completamento'],inactivity:['nome_utente','giorni_inattivita'],badge:['traguardo','nome_utente'],bank_update:['nome_materia','nome_utente']}[input.automation_id].includes(m[1]))throw fail(400,'Variabile non disponibile per questa automazione');
  return mutate(user,input,async tx=>{
   const old=(await tx.query('select revision from public.quizlab_notification_automations where automation_id=$1 for update',[input.automation_id])).rows[0];if(Number(old?.revision||0)!==Number(input.expected_revision))throw fail(409,'Automazione cambiata: ricarica');
   const result=(await tx.query('insert into public.quizlab_notification_automations(automation_id,config)values($1,$2::jsonb)on conflict(automation_id)do update set config=excluded.config,revision=quizlab_notification_automations.revision+1,updated_at=now()returning *',[input.automation_id,JSON.stringify(config)])).rows[0];
   await tx.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,\'automation\',$2::jsonb)',[user,JSON.stringify({automation_id:input.automation_id,config})]);return result;
  });
 }
 async function enqueue(user,event){
  const p=(await prefs(user)).settings;if(!event.essential&&!p.categories[event.category]||event.category==='marketing'&&!p.marketingConsent)return null;
  return(await db.query(`insert into public.quizlab_notifications(notification_id,user_id,event_key,category,title,message,destination,essential,automatic,priority,context,due_at,expires_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)on conflict(user_id,event_key)do nothing returning notification_id`,[randomUUID(),user,event.key,event.category,event.title,event.message,event.destination||'./?study=inbox',!!event.essential,!!event.automatic,event.priority||1,JSON.stringify(event.context||{}),event.due||clock(),event.expires||new Date(clock().getTime()+86400000)])).rows[0]?.notification_id||null;
 }
 async function generate(user){
  if(!(await access(user)).study)return;const p=(await prefs(user)).settings,s=await snapshot(user),rows=await items(user),autos=await automationRows();
  const name=(await db.query('select display_name from public.quizlab_profiles where user_id=$1',[user])).rows[0]?.display_name||'studente';
  async function auto(id,key,values,context={},urgent=false){const a=autos.find(a=>a.automation_id===id).config;if(!a.enabled)return;
   const merged={nome_utente:name,...values};try{await enqueue(user,{key,category:a.category,title:template(a.title,merged),message:template(a.message,merged),automatic:true,priority:a.priority,context:{automation:id,dailyLimit:a.dailyLimit,frequencyDays:a.frequencyDays,...context},destination:context.courseId?'./?study=review&course='+encodeURIComponent(context.courseId):'./?study=goals'});}catch(e){await audit(null,'template_failed',{automation:id,message:e.message});}}
  for(const item of rows){
   if(item.kind==='goal'){
    const g=core.goalValue(item.data,s,clock(),p.timeZone),ctx={itemId:item.item_id,revision:item.revision,periodKey:g.periodKey};
    if(g.status==='active')await auto('goal_reminder','goal-reminder:'+item.item_id+':'+g.periodKey+':'+Math.floor(core.dayNumber(s.today)/autos.find(a=>a.automation_id==='goal_reminder').config.frequencyDays),{obiettivo:item.data.title},ctx);
    if(g.status==='active'&&item.data.deadline){const days=core.dayNumber(item.data.deadline)-core.dayNumber(s.today);if(autos.find(a=>a.automation_id==='goal_deadline').config.intervals.includes(days))await auto('goal_deadline','goal-deadline:'+item.item_id+':'+item.revision+':'+days,{obiettivo:item.data.title,giorni_obiettivo:days},{...ctx,deadlineDays:days});}
    if(s.fresh&&(g.status==='achieved'||g.status==='active')){const thresholds=autos.find(a=>a.automation_id==='goal_progress').config.thresholds.filter(t=>t<=g.percent);const threshold=Math.max(...thresholds,0);if(threshold)await auto('goal_progress','goal-progress:'+item.item_id+':'+g.periodKey+':'+threshold,{obiettivo:item.data.title},{...ctx,threshold});}
   }else if(!item.data.cancelled&&p.countdowns){const days=core.examDays(item.data,clock(),p.timeZone),a=autos.find(a=>a.automation_id==='exam').config,c=s.courses.find(c=>c.courseId===item.data.courseId);if(c&&a.intervals.includes(days)&&(!p.courseIds.length||p.courseIds.includes(c.courseId)))await auto('exam','exam:'+item.item_id+':'+item.revision+':'+days,{nome_materia:c.subject,giorni_esame:days,...(s.fresh?{percentuale_completamento:Math.round(c.coverage)}:{})},{itemId:item.item_id,revision:item.revision,days,courseId:c.courseId});}
  }
  for(const c of s.courses.filter(c=>!p.courseIds.length||p.courseIds.includes(c.courseId))){
   if(c.review.length&&s.fresh)await auto('review','review:'+c.courseId+':'+Math.floor(core.dayNumber(s.today)/autos.find(a=>a.automation_id==='review').config.frequencyDays),{nome_materia:c.subject,domande_da_ripassare:c.review.length},{courseId:c.courseId});
  }
  if(p.inactivityDays&&s.lastStudyAt){const days=core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day);if(days>=p.inactivityDays)await auto('inactivity','inactive:'+s.lastStudyAt+':'+Math.floor((days-p.inactivityDays)/autos.find(a=>a.automation_id==='inactivity').config.frequencyDays),{...(s.fresh?{giorni_inattivita:days}:{})},{lastStudyAt:s.lastStudyAt});}
  const all=s.courses.reduce((n,c)=>n+c.unique,0),badges=[];for(const threshold of [100,500,1000])if(all>=threshold)badges.push(['unique:'+threshold,threshold+' domande diverse affrontate']);if(s.streak>=7)badges.push(['streak:7','7 giorni consecutivi']);
  for(const c of s.courses){if(c.total&&c.unique===c.total)badges.push(['bank:'+c.courseId,'Banca completata: '+c.subject]);for(const t of [80,90])if(c.attemptCount>=100&&c.accuracy>=t)badges.push(['accuracy:'+c.courseId+':'+t,'Accuratezza '+t+'%: '+c.subject]);if(c.avg5!=null&&c.exams.length>=5&&c.avg5>=27)badges.push(['exam:'+c.courseId+':27','Media almeno 27/30: '+c.subject]);if(c.averageImprovement!=null&&c.averageImprovement>=3)badges.push(['exam-improvement:'+c.courseId+':3','Media migliorata di almeno 3 punti: '+c.subject]);if(c.recoveredAll)badges.push(['recovery:'+c.courseId,'Errori recuperati: '+c.subject]);}
  if(s.fresh)for(const [key,label]of badges){const result=await db.query("insert into public.quizlab_study_badges(user_id,badge_key,label,evidence)values($1,$2,$3,$4::jsonb)on conflict(user_id,badge_key)do update set evidence=excluded.evidence where quizlab_study_badges.evidence->>'verified' is distinct from 'true' returning badge_key",[user,key,label,JSON.stringify({consolidatedAt:s.consolidatedAt,verified:true})]);if(result.rows.length)await auto('badge','badge:'+key,{traguardo:label},{badge:key});}
  const revisions=(await db.query('select course_id,bank_revision,subject from public.quizlab_banks where owner_id=$1',[user])).rows,previous=(await db.query('select data from quizlab_release_private.suite_bank_revisions where user_id=$1',[user])).rows[0]?.data;
  if(previous)for(const r of revisions){const old=previous.find(x=>x.course_id===r.course_id);if(old&&Number(r.bank_revision)>Number(old.bank_revision))await auto('bank_update','bank:'+r.course_id+':'+r.bank_revision,{nome_materia:r.subject},{courseId:r.course_id});}
  await db.query('insert into quizlab_release_private.suite_bank_revisions(user_id,signature,data)values($1,$2,$3::jsonb)on conflict(user_id)do update set signature=excluded.signature,data=excluded.data,consolidated_at=now()',[user,hash(revisions),JSON.stringify(revisions)]);
 }
 async function pertinent(n,s,p){
  if(n.expires_at&&new Date(n.expires_at)<=clock())return false;
  if(!n.essential&&!p.categories[n.category]||n.category==='marketing'&&!p.marketingConsent)return false;
  if(n.category!=='service'&&!(await access(n.user_id)).study)return false;
  const c=n.context;if(c.automation){const a=(await automationRows()).find(a=>a.automation_id===c.automation)?.config;if(!a?.enabled)return false;}
  if(c.automation==='goal_progress'&&!s.fresh)return null;
  if(c.badge&&!(await db.query("select 1 from public.quizlab_study_badges where user_id=$1 and badge_key=$2 and evidence->>\'verified\'=\'true\'",[n.user_id,c.badge])).rows.length)return null;
  if(c.courseId&&!s.courses.some(x=>x.courseId===c.courseId))return false;
  if(c.courseId&&p.courseIds.length&&!p.courseIds.includes(c.courseId))return false;
  if(c.itemId){const item=(await items(n.user_id)).find(i=>i.item_id===c.itemId);if(!item||Number(item.revision)!==Number(c.revision))return false;
   if(item.data.courseId&&(!s.courses.some(x=>x.courseId===item.data.courseId)||p.courseIds.length&&!p.courseIds.includes(item.data.courseId)))return false;
   if(item.kind==='exam'){if(item.data.cancelled||!p.countdowns||core.examDays(item.data,clock(),p.timeZone)!==c.days)return false;}
   else{const g=core.goalValue(item.data,s,clock(),p.timeZone);if(g.periodKey!==c.periodKey||['paused','expired','scheduled'].includes(g.status)||['goal_reminder','goal_deadline'].includes(c.automation)&&g.status==='achieved'||c.threshold&&(!g.valid||g.percent<c.threshold))return false;
    if(c.automation==='goal_deadline'&&(!item.data.deadline||core.dayNumber(item.data.deadline)-core.dayNumber(s.today)!==c.deadlineDays))return false;
    if(c.automation==='goal_progress'){const a=(await automationRows()).find(a=>a.automation_id===c.automation).config;if(Math.max(...a.thresholds.filter(t=>t<=g.percent),0)!==c.threshold)return false;}}}
  if(c.automation==='inactivity'&&(!p.inactivityDays||s.lastStudyAt!==c.lastStudyAt||!s.lastStudyAt||core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day)<p.inactivityDays))return false;
  if(c.automation==='review'&&(!s.fresh||!s.courses.find(x=>x.courseId===c.courseId)?.review.length))return false;
  if(c.campaignId){const campaign=(await db.query('select state,data,revision from public.quizlab_notification_campaigns where campaign_id=$1',[c.campaignId])).rows[0];if(!campaign||campaign.state==='cancelled'||Number(campaign.revision)!==Number(c.campaignRevision))return false;const current=await evaluateRecipients(campaign.data);if(!current.eligible.some(r=>r.id===n.user_id)){const reason=current.excluded.find(r=>r.id===n.user_id);return reason?.issues.some(i=>i.code==='sync_unverified')?null:false;}}
  return true;
 }
 async function refreshMessage(n,s,p){
  // Render against current consolidated data. Never send an old quantitative template.
  const context=n.context;
  if(context.campaignId){const campaign=(await db.query('select data from public.quizlab_notification_campaigns where campaign_id=$1',[context.campaignId])).rows[0];const r=(await recipients(campaign.data)).find(r=>r.id===n.user_id);if(!r)return false;n.title=r.title;n.message=r.message;}
  else if(context.automation){const a=(await automationRows()).find(a=>a.automation_id===context.automation).config;
   const name=(await db.query('select display_name from public.quizlab_profiles where user_id=$1',[n.user_id])).rows[0]?.display_name||'studente',c=s.courses.find(c=>c.courseId===context.courseId),values={nome_utente:name};
   if(context.itemId){const i=(await items(n.user_id)).find(i=>i.item_id===context.itemId);if(i?.kind==='goal'){values.obiettivo=i.data.title;if(i.data.deadline)values.giorni_obiettivo=core.dayNumber(i.data.deadline)-core.dayNumber(s.today);}if(i?.kind==='exam')values.giorni_esame=core.examDays(i.data,clock(),p.timeZone);}
   if(c){values.nome_materia=c.subject;if(s.fresh){values.percentuale_completamento=Math.round(c.coverage);values.domande_da_ripassare=c.review.length;}}
   if(s.fresh&&s.lastStudyAt)values.giorni_inattivita=core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day);
   if(context.badge)values.traguardo=(await db.query('select label from public.quizlab_study_badges where user_id=$1 and badge_key=$2',[n.user_id,context.badge])).rows[0]?.label;
   try{n.title=template(a.title,values);n.message=template(a.message,values);}catch{return false;}
   n.context={...context,dailyLimit:a.dailyLimit,frequencyDays:a.frequencyDays};n.priority=a.priority;
  }
  return true;
 }
 async function dispatch(n){
  const stored=(await db.query('select state,delivery_cancelled from public.quizlab_notifications where notification_id=$1',[n.notification_id])).rows[0];if(!stored||stored.delivery_cancelled||!['queued','ready'].includes(stored.state))return;
  const p=(await prefs(n.user_id)).settings,s=await snapshot(n.user_id);
  const pertinence=await pertinent(n,s,p);
  if(pertinence===null){await db.query('update public.quizlab_notifications set next_check_at=$2 where notification_id=$1',[n.notification_id,new Date(clock().getTime()+60000)]);return;}
  if(!pertinence){await db.query("update public.quizlab_notifications set state='cancelled' where notification_id=$1",[n.notification_id]);return;}
  if(!await refreshMessage(n,s,p)){await db.query('update public.quizlab_notifications set next_check_at=$2 where notification_id=$1',[n.notification_id,new Date(clock().getTime()+60000)]);return;}
  await db.query('update public.quizlab_notifications set title=$2,message=$3,context=$4::jsonb,priority=$5 where notification_id=$1',[n.notification_id,n.title,n.message,JSON.stringify(n.context),n.priority]);
  await db.query("update public.quizlab_notifications set state='ready' where notification_id=$1 and state='queued'",[n.notification_id]);
  await db.query('update public.quizlab_notifications set next_check_at=$2 where notification_id=$1',[n.notification_id,new Date(clock().getTime()+60000)]);
  if(!p.pushEnabled||!p.categories[n.category]||s.active&&!n.context.test||!core.deliveryWindow(p,clock(),{automatic:n.automatic,urgent:n.essential}))return;
  if(n.automatic&&!n.essential){const used=(await db.query("select n.notification_id,n.context,min(d.accepted_at) as first_sent from public.quizlab_notifications n join public.quizlab_notification_deliveries d using(notification_id) where n.user_id=$1 and n.automatic and not n.essential and d.accepted_at>=$2 and d.status in ('accepted','received','clicked') group by n.notification_id,n.context",[n.user_id,new Date(clock().getTime()-31*86400000)])).rows.filter(r=>r.notification_id!==n.notification_id);
   const day=core.localParts(clock(),p.timeZone).day;let todayCount=0;for(const row of used){const when=row.first_sent;if(when&&core.localParts(new Date(when),p.timeZone).day===day)todayCount++;}
   const sameToday=used.filter(r=>r.context.automation===n.context.automation&&r.first_sent&&core.localParts(new Date(r.first_sent),p.timeZone).day===day).length;
   if(todayCount>=2||sameToday>=(n.context.dailyLimit??2))return;
   if(used.some(r=>r.context.automation===n.context.automation&&clock()-new Date(r.first_sent)<(n.context.frequencyDays||1)*86400000))return;
  }
  const devices=(await db.query('select * from public.quizlab_notification_devices where user_id=$1 and enabled and permission=\'granted\' and subscription is not null',[n.user_id])).rows;
  for(const d of devices){
   if(n.context.testDevice&&d.device_id!==n.context.testDevice)continue;
   if(!allowRealPush&&!sendPush)continue;
   // Another request may revoke a preference/account/device while a provider call is pending.
   const currentPrefs=(await prefs(n.user_id)).settings,currentSnapshot=await snapshot(n.user_id);
   const currentDevice=(await db.query('select enabled,permission,subscription from public.quizlab_notification_devices where user_id=$1 and device_id=$2',[n.user_id,d.device_id])).rows[0];
   if(!currentDevice?.enabled||currentDevice.permission!=='granted'||!currentDevice.subscription||!currentPrefs.pushEnabled||!currentPrefs.categories[n.category]||currentSnapshot.active&&!n.context.test||!core.deliveryWindow(currentPrefs,clock(),{automatic:n.automatic,urgent:n.essential}))continue;
   if(!await pertinent(n,currentSnapshot,currentPrefs)||!await refreshMessage(n,currentSnapshot,currentPrefs))break;
   const prior=(await db.query('select * from public.quizlab_notification_deliveries where notification_id=$1 and device_id=$2',[n.notification_id,d.device_id])).rows[0];
   if(prior&&(!['retry'].includes(prior.status)||prior.attempts>=3||new Date(prior.retry_at)>clock()))continue;
   const claimed=prior?await db.query("update public.quizlab_notification_deliveries set status='sending',attempts=attempts+1,attempt_started_at=$3 where notification_id=$1 and device_id=$2 and status='retry' returning *",[n.notification_id,d.device_id,clock()]):await db.query("insert into public.quizlab_notification_deliveries(notification_id,user_id,device_id,status,attempts,attempt_started_at)values($1,$2,$3,'sending',1,$4)on conflict do nothing returning *",[n.notification_id,n.user_id,d.device_id,clock()]);if(!claimed.rows.length)continue;
   try{
    // Re-read choice per device. Private text is absent from the payload unless opted in.
    const contentVisible=currentPrefs.showPushContent===true;
    const presentation=core.pushPresentation({title:n.title,body:n.message,category:n.category,contentVisible},contentVisible);
    const payload=JSON.stringify({id:n.notification_id,...presentation,contentVisible,url:n.destination,deviceId:d.device_id,userId:n.user_id,category:n.category});
    const result=sendPush?await sendPush(currentDevice.subscription,payload,{TTL:Math.min(3600,Math.max(0,Math.floor((new Date(n.expires_at)-clock())/1000))),urgency:n.priority>=2?'high':'normal',topic:hash(n.notification_id).slice(0,32)}):await sendLabPush(currentDevice.subscription,payload,{vapidDetails:vapid,timeout:8000,TTL:Math.min(3600,Math.max(0,Math.floor((new Date(n.expires_at)-clock())/1000))),topic:hash(n.notification_id).slice(0,32),urgency:n.priority>=2?'high':'normal'});
    await db.query("update public.quizlab_notification_deliveries set status=case when clicked_at is not null then 'clicked' when received_at is not null then 'received' else 'accepted' end,provider_status=$3,accepted_at=$4 where notification_id=$1 and device_id=$2",[n.notification_id,d.device_id,result?.statusCode||201,clock()]);
   }catch(e){const code=Number(e.statusCode||0),revoked=[404,410].includes(code),retry=[429,500,502,503,504].includes(code)&&claimed.rows[0].attempts<3;
    await db.query('update public.quizlab_notification_deliveries set status=$3,provider_status=$4,failure=$5,retry_at=$6 where notification_id=$1 and device_id=$2',[n.notification_id,d.device_id,revoked?'revoked':retry?'retry':code?'failed':'unknown',code||null,pushFailureDescription(e,code),retry?new Date(clock().getTime()+60000*2**claimed.rows[0].attempts):null]);
    if(revoked)await revokeDevice(n.user_id,{device_id:d.device_id});
   }
  }
 }
 async function inbox(user,{offset=0,archived=false}={}){offset=num(Number(offset),0,1000000);if(!Number.isInteger(offset))throw fail(400,'Pagina non valida');const studyAllowed=(await access(user)).study;
  const rows=(await db.query("select notification_id,category,title,message,destination,essential,created_at,read_at,archived_at from public.quizlab_notifications where user_id=$1 and state='ready' and due_at<=$2 and (context->>'automation' is distinct from 'badge' or exists(select 1 from public.quizlab_study_badges sb where sb.user_id=$1 and sb.badge_key=quizlab_notifications.context->>'badge' and sb.evidence->>'verified'='true')) and (archived_at is not null)=$3 and ($5 or category='service') order by created_at desc limit 25 offset $4",[user,clock(),archived,offset,studyAllowed])).rows;
  const unread=(await db.query("select count(*)::integer as count from public.quizlab_notifications where user_id=$1 and state='ready' and due_at<=$2 and (context->>'automation' is distinct from 'badge' or exists(select 1 from public.quizlab_study_badges sb where sb.user_id=$1 and sb.badge_key=quizlab_notifications.context->>'badge' and sb.evidence->>'verified'='true')) and read_at is null and archived_at is null and ($3 or category='service')",[user,clock(),studyAllowed])).rows[0].count;return{rows,unread};}
 async function mark(user,input){if(!['read','unread','archive','restore','allRead'].includes(input.action))throw fail(400,'Azione non valida');if(input.action==='allRead'){await db.query("update public.quizlab_notifications set read_at=$2 where user_id=$1 and state='ready' and due_at<=$2 and read_at is null",[user,clock()]);}else{uuid(input.notification_id);const field=['archive','restore'].includes(input.action)?'archived_at':'read_at',value=['read','archive'].includes(input.action)?clock():null;await db.query('update public.quizlab_notifications set '+field+'=$3 where user_id=$1 and notification_id=$2 and state=\'ready\'',[user,input.notification_id,value]);}return{ok:true};}
 async function receipt(user,input){uuid(input.notification_id);if(!['received','clicked','session','review'].includes(input.event))throw fail(400,'Interazione non valida');const device=text(input.device_id,120),column=input.event==='clicked'?'clicked_at':'received_at';const r=await db.query("update public.quizlab_notification_deliveries set "+column+"=coalesce("+column+",$4),status=case when $5='clicked' then 'clicked' when status='clicked' then status else 'received' end where user_id=$1 and notification_id=$2 and device_id=$3 and status in ('accepted','received','clicked','sending') returning notification_id",[user,input.notification_id,device,clock(),input.event]);if(r.rows.length&&['session','review'].includes(input.event)){
  await db.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,$2,$3::jsonb) on conflict do nothing',[user,'notification_'+input.event,JSON.stringify({notification_id:input.notification_id,device_id:device})]);
 }return{ok:!!r.rows.length};}
 async function saveDiagnostics(user,input){
  const device=text(input.device_id,120),r=input.report,studyAllowed=(await access(user)).study;
  const stages=['arrived','no_policy','wrong_account','push_disabled','category_disabled','marketing_consent','duplicate','quiet_hours','invalid_destination','displayed','receiver_error'];
  const errors=[null,'Error','NotAllowedError','SecurityError','TypeError','NetworkError','AbortError','InvalidStateError','QuotaExceededError'];
  if(!r||Object.keys(r).some(k=>!['receiverVersion','rows','permission','workerState','subscriptionRegistered','subscriptionFingerprint'].includes(k))||r.receiverVersion!=='lab-push-diagnostics-1'||!['default','granted','denied','unsupported'].includes(r.permission)||!['installing','installed','activating','activated','redundant','unknown'].includes(r.workerState)||typeof r.subscriptionRegistered!=='boolean'||r.subscriptionFingerprint!=null&&!/^[a-f0-9]{64}$/.test(r.subscriptionFingerprint)||!Array.isArray(r.rows)||r.rows.length>15)throw fail(400,'Diagnostica non valida');
  const rows=r.rows.map(row=>{
   if(!row||Object.keys(row).some(k=>!['notification_id','stage','error','arrivedAt','at'].includes(k))||!stages.includes(row.stage)||!errors.includes(row.error)||![row.at,row.arrivedAt].every(v=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))))throw fail(400,'Evento diagnostico non valido');
   return{notification_id:uuid(row.notification_id),stage:row.stage,error:row.error,arrivedAt:new Date(row.arrivedAt).toISOString(),at:new Date(row.at).toISOString()};
  });
  return mutate(user,input,async tx=>{
   const saved=(await tx.query('select subscription from public.quizlab_notification_devices where user_id=$1 and device_id=$2',[user,device])).rows[0];
   if(!saved)throw fail(403,'Dispositivo non disponibile');
   const subscriptionMatchesBrowser=r.subscriptionRegistered&&r.subscriptionFingerprint?!!saved.subscription&&hash({endpoint:saved.subscription.endpoint,keys:{p256dh:saved.subscription.keys.p256dh,auth:saved.subscription.keys.auth}})===r.subscriptionFingerprint:null;
   for(const row of rows)if(!(await tx.query("select 1 from public.quizlab_notifications where user_id=$1 and notification_id=$2 and ($3 or category='service')",[user,row.notification_id,studyAllowed])).rows.length)throw fail(403,'Notifica non disponibile per questo account');
   const detail={device_id:device,receiverVersion:r.receiverVersion,permission:r.permission,workerState:r.workerState,subscriptionRegistered:r.subscriptionRegistered,subscriptionMatchesBrowser,rows};
   await tx.query("insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,'push_diagnostic',$2::jsonb)",[user,JSON.stringify(detail)]);
   const recent=(await tx.query(`select n.notification_id,n.title,n.created_at,d.status,d.accepted_at,d.received_at,d.failure from public.quizlab_notifications n left join public.quizlab_notification_deliveries d on d.notification_id=n.notification_id and d.device_id=$2 where n.user_id=$1 and ($3 or n.category='service') order by n.created_at desc limit 15`,[user,device,studyAllowed])).rows;
   return{...detail,checked_at:clock().toISOString(),recent};
  });
 }
 async function testPush(user,input){
  await requireStudy(user);
  const p=(await prefs(user)).settings;if(!p.pushEnabled||!p.categories.service)throw fail(400,'Abilita le push e le comunicazioni di servizio nelle preferenze');
  const devices=await listDevices(user);if(!devices.some(d=>d.device_id===input.device_id&&d.enabled))throw fail(400,'Questo dispositivo non ha una sottoscrizione attiva');uuid(input.request_id);
  const id=await enqueue(user,{key:'test:'+input.request_id,category:'service',title:'Prova push QuizLab',message:'Questa è una prova sul tuo dispositivo. Nessun invio agli utenti online.',context:{test:true,testDevice:input.device_id},expires:new Date(clock().getTime()+300000)});
  // Return the actual outcome of this device's attempt, not only that a message exists.
  if(id)await dispatch((await db.query('select * from public.quizlab_notifications where notification_id=$1',[id])).rows[0]);
  const delivery=id&&(await db.query('select status,failure,provider_status from public.quizlab_notification_deliveries where notification_id=$1 and user_id=$2 and device_id=$3',[id,user,input.device_id])).rows[0];
  const current=(await prefs(user)).settings;
  const outcome=delivery?.status||(!allowRealPush&&!sendPush?'disabled':!core.deliveryWindow(current,clock(),{automatic:false})?'quiet_hours':'not_sent');
  return{notification_id:id,realPushEnabled:allowRealPush,quietHoursRespected:true,outcome,failure:delivery?.failure||null,providerStatus:delivery?.provider_status||null};
 }
 async function dashboard(user){await requireStudy(user);const p=await prefs(user),s=await snapshot(user),list=await items(user);return{preferences:p,courses:s.courses.map(c=>({courseId:c.courseId,subject:c.subject,total:c.total,unique:c.unique,attemptCount:c.attemptCount,correct:c.correct,coverage:c.coverage,pending:c.pending.length,avg5:c.avg5,reviewCount:c.review.length,review:c.review.slice(0,500)})),goals:list.filter(i=>i.kind==='goal').map(i=>({...i,progress:core.goalValue(i.data,s,clock(),p.settings.timeZone)})),exams:list.filter(i=>i.kind==='exam').map(i=>({...i,days:core.examDays(i.data,clock(),p.settings.timeZone)})),badges:(await db.query('select badge_key,label,awarded_at from public.quizlab_study_badges where user_id=$1 and evidence->>\'verified\'=\'true\' order by awarded_at desc',[user])).rows,streak:s.streak,lastStudyAt:s.lastStudyAt,consolidatedAt:s.consolidatedAt,fresh:s.fresh};}
 async function campaignData(raw){
  const d={title:validateTemplate(text(raw.title,120)),message:validateTemplate(text(raw.message,1000)),category:raw.category,destination:destination(raw.destination||'./?study=inbox'),essential:!!raw.essential,filters:raw.filters||{},icon:'./icons/quizlab-sgiungla-192.png',scheduledAt:raw.scheduledAt||null,expiresAt:raw.expiresAt||new Date(clock().getTime()+7*86400000).toISOString(),references:{}};
  const refs=raw.references||{};
  if(typeof refs!=='object'||Array.isArray(refs)||Object.keys(refs).length>100)throw fail(400,'Riferimenti delle variabili non validi');
  for(const [user,value]of Object.entries(refs)){
   if(!await knownUser(user)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['courseId','goalId','examId','badgeKey'].includes(k)))throw fail(400,'Riferimenti del destinatario non validi');
   const cleaned={};for(const [key,v]of Object.entries(value)){if(key==='goalId'||key==='examId')cleaned[key]=uuid(v);else cleaned[key]=text(v,key==='badgeKey'?300:256);}d.references[user]=cleaned;
  }
  if(!categories.includes(d.category)||d.essential&&d.category!=='service'||!Number.isFinite(Date.parse(d.expiresAt))||Date.parse(d.expiresAt)<=clock().getTime()||d.scheduledAt&&!Number.isFinite(Date.parse(d.scheduledAt))||d.scheduledAt&&Date.parse(d.expiresAt)<=Date.parse(d.scheduledAt))throw fail(400,'Categoria o programmazione non valida');
  const f=d.filters;if(Object.keys(f).some(k=>!['userIds','courseId','activity','examWithinDays','minCoverage','maxCoverage','planId'].includes(k)))throw fail(400,'Filtro sconosciuto');if(f.userIds&&(!Array.isArray(f.userIds)||f.userIds.length>100||f.userIds.some(x=>!/^[0-9a-f-]{36}$/i.test(x||''))))throw fail(400,'Scegli identificativi di utenti validi');if(f.courseId)text(f.courseId,256);if(f.planId)text(f.planId,64);if(f.activity&&!['active','inactive'].includes(f.activity))throw fail(400,'Attività non valida');for(const k of ['examWithinDays','minCoverage','maxCoverage'])if(f[k]!==undefined)num(Number(f[k]),0,k==='examWithinDays'?365:100);return d;
 }
 async function campaignOptions(user){
  await admin(user);const users=[];
  for(const u of await directoryUsers()){const a=await access(u.id);if(!a.study){users.push({id:u.id,email:u.email,courses:[],goals:[],exams:[],badges:[]});continue;}
   const s=await snapshot(u.id),all=await items(u.id);
   users.push({id:u.id,email:u.email,courses:s.courses.map(c=>({id:c.courseId,label:c.subject})),
    goals:all.filter(i=>i.kind==='goal').map(i=>({id:i.item_id,label:i.data.title,courseId:i.data.courseId,deadline:i.data.deadline,paused:i.data.paused})),
    exams:all.filter(i=>i.kind==='exam').map(i=>({id:i.item_id,label:(s.courses.find(c=>c.courseId===i.data.courseId)?.subject||'Materia non disponibile')+' · '+i.data.date,courseId:i.data.courseId,cancelled:i.data.cancelled})),
    badges:(await db.query('select badge_key as id,label from public.quizlab_study_badges where user_id=$1 and evidence->>\'verified\'=\'true\' order by awarded_at desc,badge_key',[u.id])).rows});
  }return{users,fields:CAMPAIGN_FIELDS,testOnly:false};
 }
 async function evaluateRecipients(d){
  const rows=(await db.query('select u.id,u.email,p.display_name from auth.users u left join public.quizlab_profiles p on p.user_id=u.id order by u.id')).rows,eligible=[],excluded=[];
  for(const u of rows){
   if(d.filters.userIds?.length&&!d.filters.userIds.includes(u.id))continue;
   const exclude=(code,message)=>excluded.push({id:u.id,email:u.email,issues:[{code,message,variables:[]}]});
   const a=await access(u.id),p=await prefs(u.id);
   if(!a.study&&!d.essential){exclude('access_denied','L’account non ha un accesso QuizLab attivo.');continue;}
   if(!d.essential&&!p.settings.categories[d.category]||d.category==='marketing'&&!p.settings.marketingConsent){exclude('preference_denied','La categoria o il consenso promozionale non è abilitato dal destinatario.');continue;}
   const s=await snapshot(u.id),c=d.filters.courseId?s.courses.find(c=>c.courseId===d.filters.courseId):null;
   if(d.filters.courseId&&!c){exclude('course_filter','Il destinatario non possiede la materia scelta nel filtro.');continue;}
   const elapsed=s.lastStudyAt?(clock()-Date.parse(s.lastStudyAt))/86400000:Infinity;
   if(d.filters.activity==='active'&&elapsed>3||d.filters.activity==='inactive'&&elapsed<3){exclude('activity_filter','L’attività di studio non corrisponde al filtro.');continue;}
   const all=await items(u.id);
   if(d.filters.examWithinDays!==undefined&&!all.some(i=>i.kind==='exam'&&!i.data.cancelled&&core.examDays(i.data,clock(),p.settings.timeZone)>=0&&core.examDays(i.data,clock(),p.settings.timeZone)<=Number(d.filters.examWithinDays))){exclude('exam_filter','Non ci sono esami entro il periodo scelto nel filtro.');continue;}
   const coverage=c?.coverage??(s.courses.reduce((n,c)=>n+c.total,0)?s.courses.reduce((n,c)=>n+c.unique,0)/s.courses.reduce((n,c)=>n+c.total,0)*100:0);
   if((d.filters.minCoverage!==undefined||d.filters.maxCoverage!==undefined)&&!s.fresh){exclude('sync_unverified','Il filtro di copertura richiede progressi sincronizzati verificabili. Sincronizza i dispositivi e ripeti l’anteprima.');continue;}
   if(d.filters.minCoverage!==undefined&&coverage<Number(d.filters.minCoverage)||d.filters.maxCoverage!==undefined&&coverage>Number(d.filters.maxCoverage)){exclude('coverage_filter','La copertura non corrisponde al filtro.');continue;}
   if(d.filters.planId&&!(await db.query("select 1 from public.quizlab_user_access a join public.quizlab_contracts c on c.contract_id=a.current_contract_id where a.user_id=$1 and c.plan_snapshot->>'plan_id'=$2",[u.id,d.filters.planId])).rows.length){exclude('plan_filter','Il piano dell’account non corrisponde al filtro.');continue;}
   const badges=campaignVariables(d.title,d.message).includes('traguardo')?(await db.query('select badge_key,label from public.quizlab_study_badges where user_id=$1 and evidence->>\'verified\'=\'true\' order by awarded_at desc,badge_key',[u.id])).rows:[];
   const resolved=resolveCampaignTemplate({data:d,user:u,snapshot:s,preferences:p.settings,items:all,badges,now:clock()});
   if(resolved.issues.length){excluded.push({id:u.id,email:u.email,issues:resolved.issues});continue;}
   eligible.push({id:u.id,email:u.email,title:resolved.title,message:resolved.message,values:resolved.values,resolvedReferences:resolved.context,preferenceRevision:p.revision,studyAllowed:a.study});
  }return{eligible,excluded};
 }
 async function recipients(d){return(await evaluateRecipients(d)).eligible;}
 async function preview(user,input){await admin(user);const data=await campaignData(input.data),{eligible:targets,excluded}=await evaluateRecipients(data);return{data,count:targets.length,recipients:targets.map(({id,email,title,message,values,resolvedReferences})=>({id,email,title,message,values,resolvedReferences})),excluded,excludedCount:excluded.length,sample:targets[0]?{title:targets[0].title,message:targets[0].message}:null,previewHash:hash({data,targets}),testOnly:false};}
 async function saveCampaign(user,input){
  await admin(user);uuid(input.campaign_id);const data=await campaignData(input.data);if(!['draft','confirm','cancel'].includes(input.action))throw fail(400,'Azione campagna non valida');
  const p=input.action==='confirm'?await preview(user,{data}):null;if(p&&p.previewHash!==input.previewHash)throw fail(409,'Destinatari o preferenze cambiati: ripeti l’anteprima');
  if(p&&!p.count)throw fail(400,'Nessun destinatario idoneo: controlla i motivi indicati nell’anteprima.');
  // Freeze the reviewed audience. A previously excluded/newly eligible user
  // must not enter this campaign later without another admin confirmation.
  if(p)data.filters={...data.filters,userIds:p.recipients.map(r=>r.id)};
  if(p)for(const r of p.recipients){const {courseId,goalId,examId,badgeKey}=r.resolvedReferences;data.references[r.id]={...data.references[r.id],...Object.fromEntries(Object.entries({courseId,goalId,examId,badgeKey}).filter(([,v])=>v!==undefined))};}
  return mutate(user,input,async tx=>{const old=(await tx.query('select * from public.quizlab_notification_campaigns where campaign_id=$1 for update',[input.campaign_id])).rows[0];if(Number(old?.revision||0)!==Number(input.expected_revision))throw fail(409,'Campagna cambiata: ricarica');if(['sent','cancelled','expired'].includes(old?.state)&&input.action!=='cancel')throw fail(400,'Duplica la comunicazione già inviata, annullata o scaduta');const state=input.action==='cancel'?'cancelled':input.action==='confirm'?'scheduled':'draft';
   const result=(await tx.query('insert into public.quizlab_notification_campaigns(campaign_id,actor_id,data,state,scheduled_at)values($1,$2,$3::jsonb,$4,$5)on conflict(campaign_id)do update set data=excluded.data,state=excluded.state,scheduled_at=excluded.scheduled_at,revision=quizlab_notification_campaigns.revision+1,updated_at=now()returning *',[input.campaign_id,user,JSON.stringify(data),state,data.scheduledAt||clock()])).rows[0];
   if(state==='cancelled')await tx.query("update public.quizlab_notifications set delivery_cancelled=true,state=case when state='queued' then 'cancelled' else state end where context->>'campaignId'=$1 and state in ('queued','ready')",[input.campaign_id]);await tx.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,\'campaign\',$2::jsonb)',[user,JSON.stringify({id:input.campaign_id,state,count:p?.count})]);return result;});
 }
 async function campaignsDue(deadline=Infinity){
  for(const c of (await db.query("select * from public.quizlab_notification_campaigns where state='scheduled' and scheduled_at<=$1 order by scheduled_at limit 25",[clock()])).rows){
   if(Date.now()>deadline)break;
   if(Date.parse(c.data.expiresAt)<=clock().getTime()){await db.query("update public.quizlab_notification_campaigns set state='expired' where campaign_id=$1 and revision=$2 and state='scheduled'",[c.campaign_id,c.revision]);continue;}
   const current=await evaluateRecipients(c.data);
   for(const r of current.eligible)await enqueue(r.id,{key:'campaign:'+c.campaign_id+':'+c.revision,category:c.data.category,title:r.title,message:r.message,destination:c.data.destination,essential:c.data.essential,expires:new Date(c.data.expiresAt),context:{campaignId:c.campaign_id,campaignRevision:c.revision}});
   const waiting=current.excluded.some(r=>r.issues.some(i=>i.code==='sync_unverified'));
   await db.query("update public.quizlab_notification_campaigns set state=$3,generated_count=(select count(*) from public.quizlab_notifications n where n.context->>'campaignId'=$1::text and (n.context->>'campaignRevision')::bigint=$2) where campaign_id=$1 and revision=$2 and state='scheduled'",[c.campaign_id,c.revision,waiting?'scheduled':'sent']);
  }
 }
 async function tick(){if(tickPromise)return tickPromise;tickPromise=(async()=>{
  const owner=randomUUID(),claim=(await db.query("update quizlab_release_private.suite_scheduler set owner=$1,lease_until=now()+interval '110 seconds' where singleton and (lease_until is null or lease_until<now()) returning cursor",[owner])).rows[0];
  if(!claim)return{busy:true};cursor=Number(claim.cursor||0);const started=Date.now();
  try{ 
  // A crash may leave a claim without a provider result. Preserve uncertainty instead of retrying blindly.
  await db.query("update public.quizlab_notification_deliveries set status='unknown',failure='Invio interrotto; esito incerto, nessun reinvio automatico' where status='sending' and attempt_started_at<$1",[new Date(clock().getTime()-120000)]);
  await campaignsDue(started+60000);const users=(await db.query('select id from auth.users order by id limit 25 offset $1',[cursor])).rows;let processed=0;
  for(const u of users){if(Date.now()-started>70000)break;try{await generate(u.id);}catch(e){await audit(null,'generation_failed',{userId:u.id,message:e.message});}processed++;}
  cursor=processed<users.length?cursor+processed:users.length===25?cursor+25:0;
  const due=(await db.query("select * from public.quizlab_notifications where state in ('queued','ready') and not delivery_cancelled and due_at<=$1 and expires_at>$1 and (state='queued' or next_check_at<=$1) order by (state='queued') desc,next_check_at,priority desc,due_at limit 100",[clock()])).rows;
  for(const n of due){if(Date.now()-started>80000)break;const held=(await db.query("update quizlab_release_private.suite_scheduler set lease_until=now()+interval '110 seconds' where singleton and owner=$1 returning owner",[owner])).rows.length;if(!held)break;try{await dispatch(n);}catch(e){await audit(null,'dispatch_failed',{id:n.notification_id,message:e.message});}}
  await db.query("update public.quizlab_notifications set state='expired' where state='queued' and expires_at<=$1",[clock()]);return{users:users.length,notifications:due.length};
  }finally{await db.query('update quizlab_release_private.suite_scheduler set cursor=$2,lease_until=null,owner=null,last_run=now() where singleton and owner=$1',[owner,cursor]);}
 })().finally(()=>{tickPromise=null;});return tickPromise;}
 async function report(user,offset=0){await admin(user);offset=num(Number(offset),0,1000000);const totals=(await db.query(`select
  (select count(*) from public.quizlab_notification_preferences where settings->>'pushEnabled'='true') as enabled_users,
  (select count(*) from public.quizlab_notification_devices where enabled and subscription is not null) as subscriptions,
  (select count(*) from public.quizlab_notification_devices) as registered_devices,
  (select count(*) from public.quizlab_notifications) as generated,
  (select count(*) from public.quizlab_notification_deliveries where accepted_at is not null) as provider_accepted,
  (select count(*) from public.quizlab_notification_deliveries where received_at is not null) as received_signal,
  (select count(*) from public.quizlab_notification_deliveries where clicked_at is not null) as clicked_signal,
  (select count(*) from public.quizlab_notification_deliveries where status in ('failed','revoked','unknown')) as failed_or_unknown,
  (select count(*) from public.quizlab_notifications where state='queued') as queued,
  (select count(*) from public.quizlab_study_badges where evidence->>\'verified\'=\'true\') as badges,
  (select count(*) from public.quizlab_notification_audit where action='notification_session') as sessions_signalled,
  (select count(*) from public.quizlab_notification_audit where action='notification_review') as reviews_signalled,
  (select count(*) from public.quizlab_notification_campaigns where state='scheduled') as scheduled_campaigns,
  (select count(distinct user_id) from public.quizlab_notification_devices where enabled and permission='granted' and subscription is not null) as users_with_authorized_device,
  (select count(*) from public.quizlab_notification_audit where action='preferences' and detail->'before'->>'pushEnabled'='true' and detail->'after'->>'pushEnabled'='false') as push_deactivations`)).rows[0];
  totals.achieved_current_period=0;totals.study_resume_after_inactivity=0;
  for(const u of await directoryUsers()){if(!(await access(u.id)).study)continue;const p=(await prefs(u.id)).settings,s=await snapshot(u.id);
   totals.achieved_current_period+=(await items(u.id,'goal')).filter(i=>core.goalValue(i.data,s,clock(),p.timeZone).status==='achieved').length;
   if(s.lastStudyAt)totals.study_resume_after_inactivity+=Number((await db.query("select count(distinct n.notification_id) as n from public.quizlab_notifications n join public.quizlab_notification_deliveries d using(notification_id) where n.user_id=$1 and n.context->>'automation'='inactivity' and d.clicked_at is not null and d.clicked_at<$2 and d.clicked_at>$3",[u.id,s.lastStudyAt,new Date(Date.parse(s.lastStudyAt)-7*86400000)])).rows[0].n);
  }
  return{totals,automations:await automationRows(),campaigns:(await db.query('select * from public.quizlab_notification_campaigns order by updated_at desc limit 25 offset $1',[offset])).rows,
   deliveries:(await db.query('select d.notification_id,d.device_id,d.status,d.attempts,d.provider_status,d.failure,d.accepted_at,d.received_at,d.clicked_at,n.title,n.created_at from public.quizlab_notification_deliveries d join public.quizlab_notifications n using(notification_id) order by coalesce(d.accepted_at,d.attempt_started_at,n.created_at) desc,d.notification_id desc limit 25 offset $1',[offset])).rows,
   audit:(await db.query('select audit_id,action,detail,at from public.quizlab_notification_audit order by at desc limit 25 offset $1',[offset])).rows,
   users:await directoryUsers(),realPushEnabled:allowRealPush,scope:'Account UniSgiunglaLab autorizzati',measurement:'Conferme del provider e segnali dei client sono distinti. Obiettivi: periodo attuale nei dati consolidati. Ripresa dopo inattività: studio entro 7 giorni da un clic, associazione temporale senza attribuzione causale.'};
 }
 async function summary(user){
  const preference=await prefs(user),notifications=await inbox(user),a=await access(user);let overview=null;
  if(a.study){const s=await snapshot(user),all=await items(user),goals=all.filter(i=>i.kind==='goal').map(i=>({title:i.data.title,...core.goalValue(i.data,s,clock(),preference.settings.timeZone)}));
   const exams=all.filter(i=>i.kind==='exam'&&!i.data.cancelled&&core.examDays(i.data,clock(),preference.settings.timeZone)>=0).sort((x,y)=>x.data.date.localeCompare(y.data.date)||String(x.data.time||'').localeCompare(String(y.data.time||'')));
   const e=exams[0],c=e?s.courses.find(c=>c.courseId===e.data.courseId):null;
   overview={streak:s.streak,activeGoals:goals.filter(g=>g.status==='active').length,achievedGoals:goals.filter(g=>g.status==='achieved').length,consolidatedAt:s.consolidatedAt,
    nextExam:e&&c?{...e.data,subject:c.subject,days:core.examDays(e.data,clock(),preference.settings.timeZone),coverage:c.coverage}:null};
  }return{preferences:preference,unread:notifications.unread,overview};
 }
 return{prefs,savePreferences,snapshot,saveItem,registerDevice,heartbeat,listDevices,revokeDevice,dashboard,inbox,mark,receipt,saveDiagnostics,testPush,automationRows,saveAutomation,campaignOptions,preview,saveCampaign,report,summary,tick,generate,dispatch,enqueue,
  tickPending:()=>tickPromise||Promise.resolve(),publicConfig:()=>({publicKey:vapid.publicKey,realPushEnabled:allowRealPush,testOnly:false})};
}
