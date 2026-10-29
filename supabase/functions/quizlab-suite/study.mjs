import {createHash,randomUUID} from 'node:crypto';
const sendLabPush=()=>{throw Error('Server push transport required');};

import {CAMPAIGN_FIELDS,campaignVariables} from './webapp/campaign-template-fields.js';
import {resolveCampaignTemplate} from './campaign-templates.mjs';
import {lockGradebook,courseNotificationSettings} from './gradebook.mjs';
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
 goal_reminder:{category:'study',enabled:true,title:"🎯 La tua prossima conquista",message:"Il tuo obiettivo ti aspetta: «{obiettivo}». Un passo alla volta, con i tuoi tempi. 🌿",priority:1,frequencyDays:1,thresholds:[50,75,90,100],dailyLimit:2},
 goal_completed:{category:'progress',enabled:true,title:"🎉 Missione compiuta!",message:"Hai completato «{obiettivo}». Un’altra conquista nella tua Sgiungla universitaria!",priority:2,frequencyDays:1,dailyLimit:2},
 goal_progress:{category:'progress',enabled:true,title:"🌿 La tua preparazione cresce",message:"Nuova tappa raggiunta per «{obiettivo}». Ogni passo conta: avanti così!",priority:1,frequencyDays:1,thresholds:[50,75,90,100],dailyLimit:2},
 goal_deadline:{category:'study',enabled:true,title:"🧭 Tieni d’occhio la meta",message:"Giorni alla scadenza di «{obiettivo}»: {giorni_obiettivo}. Organizziamo il prossimo passo?",priority:2,frequencyDays:1,intervals:[7,3,1],dailyLimit:2},
 review:{category:'study',enabled:true,title:"🧠 Facciamo un giro di ripasso?",message:"In {nome_materia} ci sono domande da rivedere. Torniamoci insieme: anche gli errori fanno crescere. 🌱",priority:1,frequencyDays:1,dailyLimit:2},
 exam:{category:'study',enabled:true,title:"🎓 La meta si avvicina",message:"Giorni all’esame di {nome_materia}: {giorni_esame}. Un po’ di allenamento oggi, un passo avanti nella preparazione.",priority:2,frequencyDays:1,intervals:[30,14,7,3,1],dailyLimit:2},
 inactivity:{category:'study',enabled:true,title:"🐒 La Sgiungla ti aspetta",message:"Ti va di ripartire con qualche domanda? Ritrovi le tue materie e riprendi con i tuoi tempi.",priority:1,frequencyDays:3,dailyLimit:2},
 badge_near:{category:'progress',enabled:true,title:'🌱 Una conquista è vicina',message:'Stai per raggiungere «{traguardo}». Ancora un passo nella tua Sgiungla! 🌿',priority:1,frequencyDays:7,dailyLimit:1,thresholds:[85]},
 badge:{category:'progress',enabled:true,title:"🏆 Una nuova conquista!",message:"Hai ottenuto «{traguardo}». Questo risultato merita una piccola festa nella Sgiungla! 🎉",priority:1,frequencyDays:1,dailyLimit:2},
 bank_assigned:{category:'service',enabled:true,title:"📚 Una nuova materia ti aspetta",message:"{nome_materia} è disponibile nel tuo account. Entra nella Sgiungla e scegli da dove iniziare! 🌴",priority:2,frequencyDays:1,dailyLimit:2},
 bank_update:{category:'service',enabled:true,title:"🌿 Novità tra le tue materie",message:"La banca di {nome_materia} è stata aggiornata. Apri QuizLab per consultare le novità.",priority:1,frequencyDays:1,dailyLimit:2}
};
// Service communications and achievements may reach every authorized device
// while QuizLab is open. Study reminders stay quiet while the account is active.
export function notificationDeliveryPolicy(n){
 const event=n.context||{};
 const service=n.category==='service';
 const achievement=event.completion===true||event.automation==='goal_completed'||event.automation==='badge';
 const communication=!!event.campaignId&&n.category!=='marketing';
 return {allowWhileActive:service||achievement||communication||event.test===true,
  window:{automatic:!!n.automatic&&!service&&!communication,urgent:!!n.essential,immediate:service||achievement||communication||event.test===true}};
}
export function validatePreferences(raw){
 const p={...core.defaults(),...raw,categories:{...core.defaults().categories,...raw?.categories}};
 for(const key of ['pushEnabled','showPushContent','marketingConsent','countdowns'])if(typeof p[key]!=='boolean')throw fail(400,'Preferenza non valida');
 for(const key of categories)if(typeof p.categories[key]!=='boolean')throw fail(400,'Categoria non valida');
 for(const key of ['reminderTime','quietStart','quietEnd'])if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(p[key]))throw fail(400,'Orario non valido');
 try{core.localParts(new Date(),p.timeZone);}catch{throw fail(400,'Fuso orario non valido');}
 if(![0,1,3,5,7,14].includes(p.inactivityDays)||!Array.isArray(p.studyDays)||p.studyDays.length>7||p.studyDays.some(x=>!Number.isInteger(x)||x<0||x>6))throw fail(400,'Giorni non validi');
 if(!Array.isArray(p.pausedCourseIds)||p.pausedCourseIds.length>200||p.pausedCourseIds.some(x=>typeof x!=='string'||!x||x.length>256))throw fail(400,'Materie sospese non valide');
 if(!Array.isArray(p.courseIds)||p.courseIds.length>200||p.courseIds.some(x=>typeof x!=='string'||!x||x.length>256))throw fail(400,'Materie non valide');
 p.categories.marketing=p.categories.marketing&&p.marketingConsent;
 return Object.fromEntries(Object.keys(core.defaults()).map(k=>[k,k==='studyDays'?[...new Set(p[k])]:p[k]]));
}
export function studyCourseEnabled(p,id){return (!p.courseIds.length||p.courseIds.includes(id))&&!(p.pausedCourseIds||[]).includes(id);}
const subjectNoticeEnabled=(p,id)=>!(p.pausedCourseIds||[]).includes(id);
function examTemplate(config,values){return values.percentuale_completamento===undefined&&/\{percentuale_completamento\}/.test(config.title+' '+config.message)?{...config,title:'🎓 La tua prossima tappa',message:'Mancano {giorni_esame} giorni all’esame di {nome_materia}. Un passo alla volta, compà! 🌴'}:config;}
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
 async function access(user){const license=await lab.rpc(user,'quizlab_license_status');return{license,study:license.status==='active'&&(license.modules?.quizlab_pwa||license.modules?.quizlab_desktop),gradebook:license.status==='active'&&license.modules?.gradebook===true};}
 async function calendarSnapshot(user,p){
  const data=core.summarize([],clock(),p.timeZone),rows=(await db.query('select distinct on(course_id)course_id,subject from public.quizlab_banks where owner_id=$1 order by course_id,updated_at desc',[user])).rows;
  const active=(await db.query('select 1 from public.quizlab_notification_devices where user_id=$1 and active_until>$2 limit 1',[user,clock()])).rows.length>0;
  return{...data,courses:rows.map(r=>({courseId:r.course_id,subject:r.subject,unique:0,review:[],pending:[]})),fresh:false,active,consolidatedAt:null,syncStatus:{basis:'calendar-only',offlineActivityPossible:true}};
 }
 async function notificationSnapshot(user,p,n){return !n?.context?.gradebookExam||(await access(user)).study?snapshot(user):calendarSnapshot(user,p);}
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
 async function wakeNotifications(user){
  await db.query("update public.quizlab_notifications set next_check_at=$2 where user_id=$1 and state in ('queued','ready') and not delivery_cancelled and read_at is null and archived_at is null and expires_at>$2",[user,clock()]);
 }
 function clientInfo(raw={}){
  const pick=(key,allowed)=>allowed.includes(raw?.[key])?raw[key]:'unknown';
  return {platform:pick('platform',['pwa','desktop']),browser:pick('browser',['Chrome','Edge','Firefox','Safari','Samsung Internet','Opera']),os:pick('os',['Windows','Android','iOS','macOS','Linux','ChromeOS'])};
 }
 function deviceLabel(info,fallback){const parts=[info.browser,info.os].filter(x=>x&&x!=='unknown');return parts.length?parts.join(' · ')+(info.platform==='desktop'?' · Estensione':' · Web app'):fallback||'Browser non identificato';}
 async function savePreferences(user,input){
  const settings=validatePreferences(input.settings);
  return mutate(user,input,async tx=>{
   const old=(await tx.query('select * from public.quizlab_notification_preferences where user_id=$1 for update',[user])).rows[0];
   if(Number(input.expected_revision)!==Number(old?.revision||0))throw fail(409,'Preferenze cambiate su un altro dispositivo: ricarica e verifica le scelte');
   const result=(await tx.query('insert into public.quizlab_notification_preferences(user_id,settings) values($1,$2::jsonb) on conflict(user_id) do update set settings=excluded.settings,revision=quizlab_notification_preferences.revision+1,updated_at=now() returning revision,settings,updated_at',[user,JSON.stringify(settings)])).rows[0];
   await tx.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,\'preferences\',$2::jsonb)',[user,JSON.stringify({before:old?.settings||core.defaults(),after:settings})]);await tx.query("update public.quizlab_notifications set next_check_at=$2 where user_id=$1 and state in ('queued','ready') and not delivery_cancelled and read_at is null and archived_at is null and expires_at>$2",[user,clock()]);return result;
  });
 }
 function calculationGoal(goal){
  if(goal.metric!=='recovery'||goal.baselineEncoding!=='json-pair-v1')return goal;
  return{...goal,baseline:goal.baseline.map(value=>{const pair=JSON.parse(value);if(!Array.isArray(pair)||pair.length!==2||pair.some(v=>typeof v!=='string'))throw fail(409,'Riferimenti di recupero non validi');return pair[0]+'\u0000'+pair[1];})};
 }
 function goalValue(goal,s,now,zone){
  const cached=s.goalProgress?.[hash(goal)];if(cached)return cached;
  if(s.compact)throw fail(409,'Obiettivo aggiornato su un altro dispositivo: ricarica i dati');
  return core.goalValue(calculationGoal(goal),s,now,zone);
 }
 const reviewCount=c=>c.reviewCount??c.review.length;
 const pendingCount=c=>c.pendingCount??c.pending.length;
 async function snapshot(user,{details=false,interactive=false}={}){
  const preference=await prefs(user),now=clock();
  const metadata=(await db.query(`select b.id,b.course_id,b.subject,b.bank_revision,b.updated_at as bank_at,p.revision,p.updated_at
    from public.quizlab_banks b left join public.quizlab_user_courses p on p.bank_id=b.id and p.user_id=$1
    where b.owner_id=$1 and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=b.course_id)
    and not exists(select 1 from public.quizlab_user_deleted_courses d where d.user_id=$1 and d.course_id=b.course_id) order by b.id`,[user])).rows;
  const goalItems=await items(user,'goal');
  const signature=hash({engine:3,metadata,goals:goalItems.map(i=>[i.item_id,i.revision,i.data.completionEvidence||null]),timeZone:preference.settings.timeZone,day:core.localParts(now,preference.settings.timeZone).day});
  const cached=(await db.query(`select signature,case when $2 then data else jsonb_set(data,'{courses}',coalesce((select jsonb_agg((c-'review'-'pending')||jsonb_build_object('reviewCount',jsonb_array_length(c->'review'),'pendingCount',jsonb_array_length(c->'pending'),'review','[]'::jsonb,'pending','[]'::jsonb)) from jsonb_array_elements(data->'courses') c),'[]'::jsonb)) end as data from quizlab_release_private.suite_study_cache where user_id=$1`,[user,details])).rows[0];
  let data;
  if(cached?.signature===signature&&cached.data.compact&&(!cached.data.nextReviewAt||now<Date.parse(cached.data.nextReviewAt))&&(!interactive||now-Date.parse(cached.data.computedAt)<900000))data=cached.data;
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
   data.goalProgress=Object.fromEntries(goalItems.map(i=>[hash(i.data),core.goalValue(calculationGoal(i.data),data,now,preference.settings.timeZone)]));
   for(const c of data.courses){c.examCount=c.exams.length;delete c.attempts;delete c.exams;}
   data.compact=true;
   data.consolidatedAt=rows.reduce((m,r)=>r.updated_at&&new Date(r.updated_at).toISOString()>m?new Date(r.updated_at).toISOString():m,'');
   await db.query('insert into quizlab_release_private.suite_study_cache(user_id,signature,data) values($1,$2,$3::jsonb) on conflict(user_id) do update set signature=excluded.signature,data=excluded.data,consolidated_at=now()',[user,signature,JSON.stringify(data)]);
  }
  const devices=(await db.query('select pending_local,active_until from public.quizlab_notification_devices where user_id=$1',[user])).rows;
  // These are confirmed server revisions, not a claim that offline devices have no newer work.
  // Old installations and a closed browser are not failed synchronization attempts.
  const pendingDevices=devices.filter(d=>d.pending_local===true).length;
  data.fresh=pendingDevices===0;
  data.syncStatus={basis:'server-confirmed',pendingDevices,offlineActivityPossible:true};
  data.active=devices.some(d=>d.active_until&&new Date(d.active_until)>clock());
  return data;
 }
 async function items(user,kind){return(await db.query('select item_id,kind,revision,data,updated_at from public.quizlab_study_items where user_id=$1 and not deleted'+(kind?' and kind=$2':'')+' order by updated_at desc',kind?[user,kind]:[user])).rows;}
 async function goalPresentations(user,all,s,p){
  const goals=all.filter(i=>i.kind==='goal');if(!goals.length)return [];
  const proofs=(await db.query("select context,created_at from public.quizlab_notifications where user_id=$1 and context->>'automation'='goal_completed' and context->>'threshold'='100' and context->>'itemId'=any($2::text[]) order by created_at desc",[user,goals.map(i=>i.item_id)])).rows;
  return goals.map(i=>{
   const raw=goalValue(i.data,s,clock(),p.timeZone);
   // Older releases did not store the definition. Accept only the same revision,
   // or the immediately following automatic exam pause, with a matching period
   // and a still-valid completed value. Never infer from 100% during a pause alone.
   const proof=proofs.find(n=>n.context.itemId===i.item_id&&n.context.periodKey===raw.periodKey&&(Number(n.context.revision)===Number(i.revision)||i.data.closedReason==='exam_passed'&&Number(n.context.revision)===Number(i.revision)-1));
   const recorded=i.data.completionEvidence,recordedValid=recorded?.verified===true&&recorded.definition===core.goalDefinition(i.data)&&recorded.periodKey===raw.periodKey;
   const evidence=recordedValid?recorded:proof&&raw.valid&&raw.percent===100?{verified:true,definition:core.goalDefinition(i.data),periodKey:raw.periodKey,value:raw.value,target:raw.target,at:new Date(proof.created_at).toISOString()}:null;
   return {...i,progress:core.preserveCompletion(i.data,raw,evidence)};
  });
 }
 async function journey(user,all,s,p){
  const badges=(await db.query("select badge_key,label,awarded_at from public.quizlab_study_badges where user_id=$1 and evidence->>'verified'='true' order by awarded_at desc",[user])).rows;
  const effective=courseNotificationSettings(p,all);
  const next=core.badgeCandidates(s,badges).find(c=>!c.courseId||studyCourseEnabled(effective,c.courseId))||null;return{badges,next};
 }
 async function saveItem(user,input){
  await requireStudy(user);uuid(input.item_id);if(!['goal','exam'].includes(input.kind))throw fail(400,'Tipo non valido');
  const data=input.data||{},snap=await snapshot(user,{details:input.data?.metric==='recovery'});
  if(data.courseId&&!snap.courses.some(c=>c.courseId===data.courseId))throw fail(400,'Materia non disponibile nel tuo account');
  let cleaned;
  if(input.kind==='goal'){
   if(!['unique','attempts','correct','coverage','officialCoverage','accuracy','examAverage','recovery','streak'].includes(data.metric)||!['daily','weekly','custom'].includes(data.period))throw fail(400,'Obiettivo non valido');
   cleaned={title:text(data.title),courseId:data.courseId||null,metric:data.metric,period:data.period,target:num(data.metric==='recovery'?1:Number(data.target),1,['accuracy','coverage','officialCoverage'].includes(data.metric)?100:data.metric==='examAverage'?30:100000),
    startDate:data.startDate?date(data.startDate):core.localParts(clock(),(await prefs(user)).settings.timeZone).day,deadline:data.deadline?date(data.deadline):null,
    minSample:data.metric==='accuracy'?num(Number(data.minSample||30),30,100000):data.metric==='examAverage'?num(Number(data.minSample||3),3,5):1,paused:!!data.paused};
   if(cleaned.deadline&&cleaned.deadline<cleaned.startDate)throw fail(400,'Scadenza precedente all’inizio');
   if(data.metric==='recovery'){cleaned.baseline=snap.courses.filter(c=>!data.courseId||c.courseId===data.courseId).flatMap(c=>c.pending.map(q=>JSON.stringify([c.courseId,String(q)])));cleaned.baselineEncoding='json-pair-v1';}
  }else{
   if(!data.courseId)throw fail(400,'Seleziona la materia dell’esame');
   if(data.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time))throw fail(400,'Ora non valida');
   cleaned={courseId:data.courseId,date:date(data.date),time:data.time||null,preparation:text(data.preparation||'Prepararmi per l’esame',300),cancelled:!!data.cancelled};
  }
  return mutate(user,input,async tx=>{
   if(input.kind==='exam')await lockGradebook(tx,user);
   const old=(await tx.query('select * from public.quizlab_study_items where item_id=$1 for update',[input.item_id])).rows[0];
   if(!old&&(await tx.query('select count(*)::integer as n from public.quizlab_study_items where user_id=$1 and not deleted',[user])).rows[0].n>=500)throw fail(400,'Limite di 500 obiettivi ed esami attivi raggiunto');
   if(old&&(old.user_id!==user||old.kind!==input.kind))throw fail(403,'Elemento non disponibile');
   if(Number(input.expected_revision)!==Number(old?.revision||0))throw fail(409,'Elemento cambiato: ricarica prima di modificarlo');
   // Older calendar clients only send dates/preparation: never strip a real
   // grade/CFU recorded by the libretto, or reopen a passed exam silently.
   if(input.kind==='exam'&&old?.data?.gradebook){
    if(input.deleted)throw fail(409,'Questo esame contiene dati del libretto: eliminalo dal libretto con la relativa conferma');
    if(old.data.gradebook.status==='passed'&&old.data.courseId!==cleaned.courseId)throw fail(409,'Modifica il collegamento della materia dal libretto');
    cleaned.gradebook=old.data.gradebook;
    if(old.data.gradebook.status==='passed')cleaned.cancelled=true;
   }
   if(old?.data?.baseline&&old.data.metric===cleaned.metric&&old.data.courseId===cleaned.courseId){cleaned.baseline=old.data.baseline;if(old.data.baselineEncoding)cleaned.baselineEncoding=old.data.baselineEncoding;else delete cleaned.baselineEncoding;}
   if(input.kind==='goal'){cleaned.closedReason=cleaned.paused?(old?.data?.closedReason==='exam_passed'?'exam_passed':'manual'):null;if(old&&core.goalDefinition(old.data)===core.goalDefinition(cleaned)){if(old.data.completionEvidence)cleaned.completionEvidence=old.data.completionEvidence;else{const confirmed=(await goalPresentations(user,[old],snap,(await prefs(user)).settings))[0]?.progress;if(confirmed?.completionPreserved)cleaned.completionEvidence={verified:true,definition:core.goalDefinition(cleaned),periodKey:confirmed.periodKey,value:confirmed.value,target:confirmed.target,at:confirmed.completedAt};}}}
   if(cleaned.metric==='recovery'){cleaned.target=cleaned.baseline.length;cleaned.period='custom';}
   if(cleaned.metric==='recovery'&&!cleaned.baseline.length&&!input.deleted)throw fail(400,'Non ci sono errori da recuperare nella materia selezionata');
   const row=(await tx.query('insert into public.quizlab_study_items(item_id,user_id,kind,data,deleted) values($1,$2,$3,$4::jsonb,$5) on conflict(item_id) do update set data=excluded.data,deleted=excluded.deleted,revision=quizlab_study_items.revision+1,updated_at=now() returning *',[input.item_id,user,input.kind,JSON.stringify(cleaned),!!input.deleted])).rows[0];
   await tx.query("update public.quizlab_notifications set delivery_cancelled=true,state=case when state='queued' then 'cancelled' else state end where user_id=$1 and state in ('queued','ready') and context->>'itemId'=$2",[user,input.item_id]);return row;
  });
 }
 async function registerDevice(user,input){
  if(input.expected_user_id&&input.expected_user_id!==user)throw fail(403,'Account cambiato');
  const device=text(input.device_id,120),info=clientInfo(input.client_info),label=text(deviceLabel(info,input.label||'Browser'),80),permission=input.permission;
  if(!['default','granted','denied','unsupported'].includes(permission))throw fail(400,'Permesso non valido');
  let subscription=input.subscription||null,endpointHash=null;
  if(subscription){if(!endpointAllowed(subscription.endpoint)||!/^[A-Za-z0-9_-]{87}$/.test(subscription.keys?.p256dh||'')||!/^[A-Za-z0-9_-]{22}$/.test(subscription.keys?.auth||''))throw fail(400,'Sottoscrizione push non valida');endpointHash=hash(subscription.endpoint);subscription={endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth}};}
  const old=(await db.query('select user_id from public.quizlab_notification_devices where endpoint_hash=$1',[endpointHash])).rows[0];if(old&&old.user_id!==user)throw fail(409,'Questo browser è associato a un altro account. Esci da quell’account e riattiva le notifiche.');
  await db.query(`insert into public.quizlab_notification_devices(user_id,device_id,label,permission,subscription,endpoint_hash,enabled,last_seen,client_info)values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb)
   on conflict(user_id,device_id)do update set label=excluded.label,permission=excluded.permission,subscription=excluded.subscription,endpoint_hash=excluded.endpoint_hash,enabled=excluded.enabled,last_seen=excluded.last_seen,client_info=case when excluded.client_info->>'platform'='unknown' then quizlab_notification_devices.client_info else excluded.client_info end`,[user,device,label,permission,JSON.stringify(subscription),endpointHash,!!subscription&&permission==='granted',clock(),JSON.stringify(info)]);
  await wakeNotifications(user);return{ok:true};
 }
 async function heartbeat(user,input){
  if(input.expected_user_id&&input.expected_user_id!==user)throw fail(403,'Account cambiato');
  const id=text(input.device_id,120),info=clientInfo(input.client_info),old=(await db.query('select pending_local,active_until from public.quizlab_notification_devices where user_id=$1 and device_id=$2',[user,id])).rows[0];
  if(typeof input.clean!=='boolean'||typeof input.active!=='boolean')throw fail(400,'Stato del dispositivo non valido');
  await db.query(`insert into public.quizlab_notification_devices(user_id,device_id,label,permission,clean,active_until,last_seen,client_info,pending_local) values($1,$2,$3,'default',$4,$5,$6,$7::jsonb,$8)
   on conflict(user_id,device_id)do update set clean=excluded.clean,active_until=excluded.active_until,last_seen=excluded.last_seen,pending_local=excluded.pending_local,
   label=case when excluded.client_info->>'platform'='unknown' then quizlab_notification_devices.label else excluded.label end,
   client_info=case when excluded.client_info->>'platform'='unknown' then quizlab_notification_devices.client_info else excluded.client_info end`,[user,id,deviceLabel(info,'Installazione QuizLab'),input.clean,input.active?new Date(clock().getTime()+90000):null,clock(),JSON.stringify(info),!input.clean]);
  if(!old||old.pending_local!==!input.clean||!input.active&&old.active_until)await wakeNotifications(user);return{ok:true};
 }
 async function listDevices(user){return(await db.query('select device_id,label,enabled,permission,last_seen,client_info,pending_local,(subscription is not null) as has_subscription from public.quizlab_notification_devices where user_id=$1 order by last_seen desc limit 50',[user])).rows;}
 async function revokeDevice(user,input){await db.query('update public.quizlab_notification_devices set enabled=false,subscription=null,endpoint_hash=null where user_id=$1 and device_id=$2',[user,text(input.device_id,120)]);return{ok:true};}
 async function automationRows(){const saved=(await db.query('select * from public.quizlab_notification_automations')).rows;return Object.entries(AUTOMATIONS).map(([automation_id,config])=>{const old=saved.find(r=>r.automation_id===automation_id);return{automation_id,revision:old?.revision||0,config:{...config,...old?.config}};});}
 async function saveAutomation(user,input){
  await admin(user);if(!AUTOMATIONS[input.automation_id])throw fail(400,'Automazione sconosciuta');
  const base=AUTOMATIONS[input.automation_id],v=input.config||{};if(typeof v.enabled!=='boolean')throw fail(400,'Attivazione non valida');
  const config={...base,enabled:v.enabled,title:validateTemplate(text(v.title,120)),message:validateTemplate(text(v.message,1000)),priority:num(Number(v.priority),0,3),frequencyDays:num(Number(v.frequencyDays),1,30),dailyLimit:num(Number(v.dailyLimit),0,2)};
  if(base.intervals){if(!Array.isArray(v.intervals)||v.intervals.length>10||v.intervals.some(x=>!Number.isInteger(x)||x<1||x>365))throw fail(400,'Intervalli non validi');config.intervals=[...new Set(v.intervals)].sort((a,b)=>b-a);}
  if(base.thresholds){if(!Array.isArray(v.thresholds)||v.thresholds.length>10||v.thresholds.some(x=>!Number.isInteger(x)||x<1||x>100))throw fail(400,'Soglie non valide');config.thresholds=[...new Set(v.thresholds)].sort((a,b)=>a-b);}
  for(const t of [config.title,config.message])for(const m of t.matchAll(/\{([a-z_]+)\}/g))if(!{goal_reminder:['obiettivo','nome_utente'],goal_progress:['obiettivo','nome_utente'],goal_completed:['obiettivo','nome_utente'],goal_deadline:['obiettivo','nome_utente','giorni_obiettivo'],review:['nome_materia','nome_utente','domande_da_ripassare'],exam:['nome_materia','nome_utente','giorni_esame','percentuale_completamento'],inactivity:['nome_utente','giorni_inattivita'],badge_near:['traguardo','nome_utente'],badge:['traguardo','nome_utente'],bank_update:['nome_materia','nome_utente'],bank_assigned:['nome_materia','nome_utente']}[input.automation_id].includes(m[1]))throw fail(400,'Variabile non disponibile per questa automazione');
  return mutate(user,input,async tx=>{
   const old=(await tx.query('select revision from public.quizlab_notification_automations where automation_id=$1 for update',[input.automation_id])).rows[0];if(Number(old?.revision||0)!==Number(input.expected_revision))throw fail(409,'Automazione cambiata: ricarica');
   const result=(await tx.query('insert into public.quizlab_notification_automations(automation_id,config)values($1,$2::jsonb)on conflict(automation_id)do update set config=excluded.config,revision=quizlab_notification_automations.revision+1,updated_at=now()returning *',[input.automation_id,JSON.stringify(config)])).rows[0];
   await tx.query('insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,\'automation\',$2::jsonb)',[user,JSON.stringify({automation_id:input.automation_id,config})]);return result;
  });
 }
 async function enqueue(user,event){
  const p=(await prefs(user)).settings;if(!event.essential&&!p.categories[event.category]||event.category==='marketing'&&!p.marketingConsent)return null;
  return(await db.query(`insert into public.quizlab_notifications(notification_id,user_id,event_key,category,title,message,destination,essential,automatic,priority,context,due_at,expires_at,next_check_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)on conflict(user_id,event_key)do nothing returning notification_id`,[randomUUID(),user,event.key,event.category,event.title,event.message,event.destination||'./?study=inbox',!!event.essential,!!event.automatic,event.priority||1,JSON.stringify(event.context||{}),event.due||clock(),event.expires||new Date(clock().getTime()+86400000),clock()])).rows[0]?.notification_id||null;
 }
 async function generationInfo(user){
  return(await db.query(`select md5(jsonb_build_object(
   'engine',6,
   'assignments',(select count(*) from public.quizlab_assignment_events where user_id=$1 and processed_at is null),
   'review_due',(select coalesce((data->>'nextReviewAt')::timestamptz<=$2,false) from quizlab_release_private.suite_study_cache where user_id=$1),
   'day',to_char($2::timestamptz at time zone coalesce(np.settings->>'timeZone','Europe/Rome'),'YYYY-MM-DD'),
   'banks',(select jsonb_agg(jsonb_build_array(b.id,b.course_id,b.bank_revision,b.updated_at,p.revision,p.updated_at) order by b.id) from public.quizlab_banks b left join public.quizlab_user_courses p on p.bank_id=b.id and p.user_id=$1 where b.owner_id=$1),
   'items',(select jsonb_agg(jsonb_build_array(item_id,revision,deleted) order by item_id) from public.quizlab_study_items where user_id=$1),
   'access',(select jsonb_build_array(status,expires_at,starts_at,license_revision,coalesce(expires_at>$2,true),coalesce(starts_at<=$2,true)) from public.quizlab_user_access where user_id=$1),
   'automations',(select max(updated_at) from public.quizlab_notification_automations),
   'preferences',np.revision,
   'retired',(select jsonb_agg(course_id order by course_id) from public.quizlab_retired_courses),
   'deleted',(select jsonb_agg(course_id order by course_id) from public.quizlab_user_deleted_courses where user_id=$1),
   'devices',(select jsonb_agg(jsonb_build_array(device_id,pending_local,enabled,permission,endpoint_hash) order by device_id) from public.quizlab_notification_devices where user_id=$1),
   'writers',(select jsonb_agg(client_id order by client_id) from public.quizlab_devices where user_id=$1)
   )::text) as signature,g.signature as previous from (select $1::uuid as user_id) x
   left join public.quizlab_notification_preferences np using(user_id) left join quizlab_release_private.suite_generation g using(user_id)`,[user,clock()])).rows[0];
 }
 async function generationDone(user,signature){await db.query('insert into quizlab_release_private.suite_generation(user_id,signature,evaluated_at) values($1,$2,$3) on conflict(user_id)do update set signature=excluded.signature,evaluated_at=excluded.evaluated_at',[user,signature,clock()]);}
 async function generate(user){
  const fingerprint=await generationInfo(user);if(fingerprint.signature===fingerprint.previous)return false;
  const rights=await access(user);if(!rights.study&&!rights.gradebook){await generationDone(user,fingerprint.signature);return false;}const rows=await items(user),p=courseNotificationSettings((await prefs(user)).settings,rows),s=rights.study?await snapshot(user):await calendarSnapshot(user,p),autos=await automationRows();
  const name=(await db.query('select display_name from public.quizlab_profiles where user_id=$1',[user])).rows[0]?.display_name||'studente';
  async function auto(id,key,values,context={},urgent=false){const raw=autos.find(a=>a.automation_id===id).config,a=id==='exam'?examTemplate(raw,values):raw;if(!a.enabled)return {handled:true};
   if(context.courseId&&!subjectNoticeEnabled(p,context.courseId))return {handled:true};
   const merged={nome_utente:name,...values};try{await enqueue(user,{key,category:a.category,title:template(a.title,merged),message:template(a.message,merged),automatic:true,priority:a.priority,context:{automation:id,dailyLimit:a.dailyLimit,frequencyDays:a.frequencyDays,...context},destination:'./?study='+(id==='review'?'review':['bank_update','bank_assigned'].includes(id)?'inbox':id==='exam'?'exams':['badge','badge_near'].includes(id)?'badges':'goals')+(context.courseId?'&course='+encodeURIComponent(context.courseId):'')});return {handled:true};}catch(e){await audit(null,'template_failed',{automation:id,message:e.message});return {handled:false};}}
  for(const item of rows){
   if(item.data.courseId&&!studyCourseEnabled(p,item.data.courseId))continue;
   if(item.kind==='goal'){
    if(!rights.study)continue;
    if(item.data.paused)continue;
    const g=goalValue(item.data,s,clock(),p.timeZone);
    if(s.fresh&&g.status==='achieved'&&!g.completionPreserved){const evidence={verified:true,definition:core.goalDefinition(item.data),periodKey:g.periodKey,value:g.value,target:g.target,at:clock().toISOString()};const changed=(await db.query("update public.quizlab_study_items set data=jsonb_set(data,'{completionEvidence}',$4::jsonb) where user_id=$1 and item_id=$2 and revision=$3 returning revision",[user,item.item_id,item.revision,JSON.stringify(evidence)])).rows[0];if(!changed)continue;item.revision=changed.revision;}
    const ctx={itemId:item.item_id,revision:item.revision,periodKey:g.periodKey,...(item.data.courseId?{courseId:item.data.courseId}:{})};
    if(g.status==='active')await auto('goal_reminder','goal-reminder:'+item.item_id+':'+g.periodKey+':'+Math.floor(core.dayNumber(s.today)/autos.find(a=>a.automation_id==='goal_reminder').config.frequencyDays),{obiettivo:item.data.title},ctx);
    if(g.status==='active'&&item.data.deadline){const days=core.dayNumber(item.data.deadline)-core.dayNumber(s.today);if(autos.find(a=>a.automation_id==='goal_deadline').config.intervals.includes(days))await auto('goal_deadline','goal-deadline:'+item.item_id+':'+item.revision+':'+days,{obiettivo:item.data.title,giorni_obiettivo:days},{...ctx,deadlineDays:days});}
    if(s.fresh&&g.valid&&g.status==='achieved'){
     const completionBasis=hash({metric:item.data.metric,courseId:item.data.courseId||null,target:g.target,periodKey:item.data.metric==='recovery'?'once':g.periodKey,minSample:item.data.minSample||1,baseline:item.data.metric==='recovery'?item.data.baseline:undefined});
     // A rename or pause is not a new achievement. Legacy events without a basis
     // remain deduplicated conservatively; cancelled drafts can be regenerated.
     const already=(await db.query("select 1 from public.quizlab_notifications where user_id=$1 and context->>'itemId'=$2 and context->>'threshold'='100' and state in ('queued','ready') and (context->>'completionBasis'=$3 or context->>'completionBasis' is null and (context->>'revision'=$4 or context->>'periodKey'=$5)) limit 1",[user,item.item_id,completionBasis,String(item.revision),g.periodKey])).rows.length;
     if(!already)await auto('goal_completed','goal-progress:'+item.item_id+':'+item.revision+':'+g.periodKey+':100',{obiettivo:item.data.title},{...ctx,threshold:100,completion:true,completionBasis});
     await db.query("update public.quizlab_notifications set state='cancelled',push_state='superseded' where user_id=$1 and state='queued' and context->>'itemId'=$2 and context->>'automation' in ('goal_reminder','goal_deadline','goal_progress') and coalesce((context->>'threshold')::integer,0)<100",[user,item.item_id]);
    }else if(s.fresh&&g.status==='active'){const thresholds=autos.find(a=>a.automation_id==='goal_progress').config.thresholds.filter(t=>t<100&&t<=g.percent);const threshold=Math.max(...thresholds,0);if(threshold)await auto('goal_progress','goal-progress:'+item.item_id+':'+item.revision+':'+g.periodKey+':'+threshold,{obiettivo:item.data.title},{...ctx,threshold});}
   }else if(!item.data.cancelled&&item.data.date&&p.countdowns){const days=core.examDays(item.data,clock(),p.timeZone),a=autos.find(a=>a.automation_id==='exam').config,c=s.courses.find(c=>c.courseId===item.data.courseId),subject=item.data.gradebook?.subject||c?.subject;if(subject&&a.intervals.includes(days))await auto('exam','exam:'+item.item_id+':'+item.revision+':'+days,{nome_materia:subject,giorni_esame:days,...(s.fresh&&c?{percentuale_completamento:Math.round(c.coverage)}:{})},{itemId:item.item_id,revision:item.revision,days,...(item.data.courseId?{courseId:item.data.courseId}:{}),gradebookExam:rights.gradebook});}
  }
  for(const c of s.courses.filter(c=>studyCourseEnabled(p,c.courseId))){
   if(reviewCount(c)&&s.fresh)await auto('review','review:'+c.courseId+':'+Math.floor(core.dayNumber(s.today)/autos.find(a=>a.automation_id==='review').config.frequencyDays),{nome_materia:c.subject,domande_da_ripassare:reviewCount(c)},{courseId:c.courseId});
  }
  if(p.inactivityDays&&s.lastStudyAt&&s.courses.some(c=>studyCourseEnabled(p,c.courseId))){const days=core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day);if(days>=p.inactivityDays)await auto('inactivity','inactive:'+s.lastStudyAt+':'+Math.floor((days-p.inactivityDays)/autos.find(a=>a.automation_id==='inactivity').config.frequencyDays),{...(s.fresh?{giorni_inattivita:days}:{})},{lastStudyAt:s.lastStudyAt});}
  const all=s.courses.reduce((n,c)=>n+c.unique,0),badges=[];for(const threshold of [100,500,1000])if(all>=threshold)badges.push(['unique:'+threshold,threshold+' domande diverse affrontate']);if(s.streak>=7)badges.push(['streak:7','7 giorni consecutivi']);
  for(const c of s.courses){if(c.total&&c.unique===c.total)badges.push(['bank:'+c.courseId,'Banca completata: '+c.subject]);for(const t of [80,90])if(c.attemptCount>=100&&c.accuracy>=t)badges.push(['accuracy:'+c.courseId+':'+t,'Accuratezza '+t+'%: '+c.subject]);if(c.avg5!=null&&c.examCount>=5&&c.avg5>=27)badges.push(['exam:'+c.courseId+':27','Media almeno 27/30: '+c.subject]);if(c.averageImprovement!=null&&c.averageImprovement>=3)badges.push(['exam-improvement:'+c.courseId+':3','Media migliorata di almeno 3 punti: '+c.subject]);if(c.recoveredAll)badges.push(['recovery:'+c.courseId,'Errori recuperati: '+c.subject]);}
  if(s.fresh)for(const [key,label]of badges){const result=await db.query("insert into public.quizlab_study_badges(user_id,badge_key,label,evidence)values($1,$2,$3,$4::jsonb)on conflict(user_id,badge_key)do update set evidence=excluded.evidence where quizlab_study_badges.evidence->>'verified' is distinct from 'true' returning badge_key",[user,key,label,JSON.stringify({consolidatedAt:s.consolidatedAt,verified:true})]);const course=s.courses.find(c=>['bank:','accuracy:','exam:','exam-improvement:','recovery:'].some(prefix=>key.startsWith(prefix+c.courseId)&&(!key.slice((prefix+c.courseId).length)||key.slice((prefix+c.courseId).length).startsWith(':'))));if(result.rows.length)await auto('badge','badge:'+key,{traguardo:label},{badge:key,...(course?{courseId:course.courseId}:{})});}
  if(rights.study&&s.fresh&&s.courses.some(c=>studyCourseEnabled(p,c.courseId))){const j=await journey(user,rows,s,p),candidate=j.next,a=autos.find(a=>a.automation_id==='badge_near').config;
   if(candidate&&candidate.percent>=Math.min(...a.thresholds)&&!core.goalOverlapsBadge(candidate,rows.filter(i=>i.kind==='goal'&&goalValue(i.data,s,clock(),p.timeZone).status==='active')))await auto('badge_near','badge-near:'+candidate.key,{traguardo:candidate.label},{nearBadge:candidate.key,...(candidate.courseId?{courseId:candidate.courseId}:{})});
  }
  const assigned=rights.study?(await db.query('select e.bank_id,e.course_id,e.revision,b.subject from public.quizlab_assignment_events e join public.quizlab_banks b on b.id=e.bank_id and b.owner_id=e.user_id where e.user_id=$1 and e.processed_at is null order by e.created_at limit 50',[user])).rows:[];
  for(const e of assigned){const outcome=await auto('bank_assigned','assigned:'+e.bank_id,{nome_materia:e.subject},{courseId:e.course_id,bankId:e.bank_id});if(outcome?.handled)await db.query('update public.quizlab_assignment_events set processed_at=$2 where bank_id=$1 and processed_at is null',[e.bank_id,clock()]);}
  const revisions=rights.study?(await db.query('select course_id,bank_revision,subject from public.quizlab_banks where owner_id=$1',[user])).rows:[],previous=rights.study?(await db.query('select data from quizlab_release_private.suite_bank_revisions where user_id=$1',[user])).rows[0]?.data:null;
  if(Array.isArray(previous))for(const r of revisions){const old=previous.find(x=>x.course_id===r.course_id);if(old&&!assigned.some(e=>e.course_id===r.course_id)&&Number(r.bank_revision)>Number(old.bank_revision))await auto('bank_update','bank:'+r.course_id+':'+r.bank_revision,{nome_materia:r.subject},{courseId:r.course_id});}
  if(rights.study)await db.query('insert into quizlab_release_private.suite_bank_revisions(user_id,signature,data)values($1,$2,$3::jsonb)on conflict(user_id)do update set signature=excluded.signature,data=excluded.data,consolidated_at=now()',[user,hash(revisions),JSON.stringify(revisions)]);
  await generationDone(user,fingerprint.signature);
  await db.query("update public.quizlab_notifications set next_check_at=$2 where user_id=$1 and state in ('queued','ready') and not delivery_cancelled and expires_at>$2 and read_at is null and archived_at is null",[user,clock()]);return true;
 }
 async function pertinent(n,s,p){
  if(n.expires_at&&new Date(n.expires_at)<=clock())return false;
  if(!n.essential&&!p.categories[n.category]||n.category==='marketing'&&!p.marketingConsent)return false;
  if(n.category!=='service'){const rights=await access(n.user_id);if(!rights.study&&!(rights.gradebook&&n.context.automation==='exam'&&n.context.gradebookExam))return false;}
  const c=n.context;if(c.automation){const a=(await automationRows()).find(a=>a.automation_id===c.automation)?.config;if(!a?.enabled)return false;}
  const allItems=c.courseId||c.itemId||c.badge||c.automation==='inactivity'?await items(n.user_id):[],effective=courseNotificationSettings(p,allItems);
  const badgeCourse=c.badge?s.courses.find(course=>['bank:','accuracy:','exam:','exam-improvement:','recovery:'].some(prefix=>c.badge.startsWith(prefix+course.courseId)&&(!c.badge.slice((prefix+course.courseId).length)||c.badge.slice((prefix+course.courseId).length).startsWith(':'))))?.courseId:null;
  if(badgeCourse&&!studyCourseEnabled(effective,badgeCourse))return false;
  if(['goal_progress','goal_completed','review'].includes(c.automation)&&!s.fresh)return null;
  if(c.badge&&!(await db.query("select 1 from public.quizlab_study_badges where user_id=$1 and badge_key=$2 and evidence->>\'verified\'=\'true\'",[n.user_id,c.badge])).rows.length)return null;
  if(c.courseId&&!c.gradebookExam&&!s.courses.some(x=>x.courseId===c.courseId))return false;
  if(c.courseId&&!subjectNoticeEnabled(effective,c.courseId))return false;
  if(c.nearBadge){if(!s.fresh)return null;const all=await items(n.user_id);if(!s.courses.some(course=>studyCourseEnabled(courseNotificationSettings(p,all),course.courseId)))return false;const j=await journey(n.user_id,all,s,p),candidate=j.next,a=(await automationRows()).find(a=>a.automation_id==='badge_near').config;if(!candidate||candidate.key!==c.nearBadge||candidate.percent<Math.min(...a.thresholds)||core.goalOverlapsBadge(candidate,all.filter(i=>i.kind==='goal'&&goalValue(i.data,s,clock(),p.timeZone).status==='active')))return false;}
  if(c.itemId){const item=allItems.find(i=>i.item_id===c.itemId);if(!item||Number(item.revision)!==Number(c.revision))return false;
   if(item.data.courseId&&(!c.gradebookExam&&!s.courses.some(x=>x.courseId===item.data.courseId)||!studyCourseEnabled(effective,item.data.courseId)))return false;
   if(item.kind==='exam'){if(item.data.cancelled||!p.countdowns||core.examDays(item.data,clock(),p.timeZone)!==c.days)return false;}
   else{if(item.data.paused)return false;const g=goalValue(item.data,s,clock(),p.timeZone);if(g.periodKey!==c.periodKey||['paused','expired','scheduled'].includes(g.status)||['goal_reminder','goal_deadline'].includes(c.automation)&&g.status==='achieved'||c.threshold&&(!g.valid||g.percent<c.threshold))return false;
    if(c.automation==='goal_deadline'&&(!item.data.deadline||core.dayNumber(item.data.deadline)-core.dayNumber(s.today)!==c.deadlineDays))return false;
    if(c.automation==='goal_completed'&&g.status!=='achieved')return false;
    if(c.automation==='goal_progress'){const a=(await automationRows()).find(a=>a.automation_id===c.automation).config;if(Math.max(...a.thresholds.filter(t=>t<=g.percent),0)!==c.threshold)return false;}}}
  if(c.automation==='inactivity'&&(!s.courses.some(course=>studyCourseEnabled(effective,course.courseId))||!p.inactivityDays||s.lastStudyAt!==c.lastStudyAt||!s.lastStudyAt||core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day)<p.inactivityDays))return false;
  if(c.automation==='review'&&(!s.fresh||!reviewCount(s.courses.find(x=>x.courseId===c.courseId)||{review:[]})))return false;
  if(c.automation==='bank_assigned'&&!(await db.query('select 1 from public.quizlab_banks where id=$1 and owner_id=$2 and course_id=$3',[c.bankId,n.user_id,c.courseId])).rows.length)return false;
  if(c.campaignId){const campaign=(await db.query('select state,data,revision from public.quizlab_notification_campaigns where campaign_id=$1',[c.campaignId])).rows[0];if(!campaign||campaign.state==='cancelled'||Number(campaign.revision)!==Number(c.campaignRevision))return false;const current=await evaluateRecipients(campaign.data);if(!current.eligible.some(r=>r.id===n.user_id)){const reason=current.excluded.find(r=>r.id===n.user_id);return reason?.issues.some(i=>i.code==='sync_unverified')?null:false;}}
  return true;
 }
 async function refreshMessage(n,s,p){
  // Render against current consolidated data. Never send an old quantitative template.
  const context=n.context;
  if(context.campaignId){const campaign=(await db.query('select data from public.quizlab_notification_campaigns where campaign_id=$1',[context.campaignId])).rows[0];const r=(await recipients(campaign.data)).find(r=>r.id===n.user_id);if(!r)return false;n.title=r.title;n.message=r.message;}
  else if(context.automation){const a=(await automationRows()).find(a=>a.automation_id===context.automation).config;
   const name=(await db.query('select display_name from public.quizlab_profiles where user_id=$1',[n.user_id])).rows[0]?.display_name||'studente',c=s.courses.find(c=>c.courseId===context.courseId),values={nome_utente:name};
   if(context.itemId){const i=(await items(n.user_id)).find(i=>i.item_id===context.itemId);if(i?.kind==='goal'){values.obiettivo=i.data.title;if(i.data.deadline)values.giorni_obiettivo=core.dayNumber(i.data.deadline)-core.dayNumber(s.today);}if(i?.kind==='exam'){values.giorni_esame=core.examDays(i.data,clock(),p.timeZone);values.nome_materia=i.data.gradebook?.subject||c?.subject;}}
   if(c){values.nome_materia=c.subject;if(s.fresh){values.percentuale_completamento=Math.round(c.coverage);values.domande_da_ripassare=reviewCount(c);}}
   if(s.fresh&&s.lastStudyAt)values.giorni_inattivita=core.dayNumber(s.today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day);
   if(context.badge)values.traguardo=(await db.query('select label from public.quizlab_study_badges where user_id=$1 and badge_key=$2',[n.user_id,context.badge])).rows[0]?.label;
   if(context.nearBadge){const j=await journey(n.user_id,await items(n.user_id),s,p);if(j.next?.key!==context.nearBadge)return false;values.traguardo=j.next.label;}
   const rendered=context.automation==='exam'?examTemplate(a,values):a;
   try{n.title=template(rendered.title,values);n.message=template(rendered.message,values);}catch{return false;}
   n.context={...context,dailyLimit:a.dailyLimit,frequencyDays:a.frequencyDays};n.priority=a.priority;
  }
  return true;
 }
 async function deliveryState(id){
  const states=(await db.query('select status from public.quizlab_notification_deliveries where notification_id=$1',[id])).rows.map(r=>r.status);
  for(const [status,label]of [['clicked','displayed'],['received','displayed'],['accepted','provider_accepted'],['sending','sending'],['retry','retry'],['unknown','unknown'],['failed','failed'],['revoked','revoked']])if(states.includes(status))return label;
  return null;
 }
 async function dispatch(n,{revalidate=false}={}){
  const policy=notificationDeliveryPolicy(n),windowOptions=policy.window;
  const postpone=async(ms,reason)=>db.query('update public.quizlab_notifications set next_check_at=$2,push_state=$3,push_checked_at=$4 where notification_id=$1',[n.notification_id,new Date(clock().getTime()+ms),reason||'waiting',clock()]);
  const waitWindow=async p=>{const next=core.nextDeliveryAt(p,clock(),windowOptions);await postpone(next?Math.max(1000,next-clock()):86400000,core.inQuietHours(p,clock())?'quiet_hours':'reminder_time');};
  const stored=(await db.query('select state,delivery_cancelled,read_at,archived_at from public.quizlab_notifications where notification_id=$1',[n.notification_id])).rows[0];if(!stored||stored.delivery_cancelled||!['queued','ready'].includes(stored.state))return;
  const p=(await prefs(n.user_id)).settings;
  if(stored.read_at||stored.archived_at){await postpone(86400000,stored.read_at?'read':'archived');return;}
  if(stored.state==='ready'&&!revalidate){
   if(!p.pushEnabled||!p.categories[n.category]){await postpone(86400000,!p.pushEnabled?'push_disabled':'category_disabled');return;}
   if(!core.deliveryWindow(p,clock(),windowOptions)){await waitWindow(p);return;}
   const pending=(await db.query("select exists(select 1 from public.quizlab_notification_devices d left join public.quizlab_notification_deliveries l on l.notification_id=$2 and l.device_id=d.device_id where d.user_id=$1 and d.enabled and d.permission='granted' and d.subscription is not null and ($3::text is null or d.device_id=$3) and (l.notification_id is null or l.status='retry' and l.attempts<3)) as pending",[n.user_id,n.notification_id,n.context.testDevice||null])).rows[0].pending;
   if(!pending){const configured=(await db.query("select exists(select 1 from public.quizlab_notification_devices where user_id=$1 and enabled and permission='granted' and subscription is not null) as ok",[n.user_id])).rows[0].ok;await postpone(86400000,await deliveryState(n.notification_id)||(configured?'no_pending_delivery':'no_device'));return;}
  }
  if(n.context.badge&&!(await db.query("select 1 from public.quizlab_study_badges where user_id=$1 and badge_key=$2 and evidence->>'verified'='true'",[n.user_id,n.context.badge])).rows.length){await postpone(86400000);return;}
  const s=await notificationSnapshot(n.user_id,p,n);
  const pertinence=await pertinent(n,s,p);
  if(pertinence===null){await postpone(900000,'sync_pending');return;}
  if(!pertinence){await db.query("update public.quizlab_notifications set state='cancelled',push_state='not_relevant',push_checked_at=$2 where notification_id=$1",[n.notification_id,clock()]);return;}
  if(!await refreshMessage(n,s,p)){await postpone(900000,'context_pending');return;}
  await db.query('update public.quizlab_notifications set title=$2,message=$3,context=$4::jsonb,priority=$5 where notification_id=$1',[n.notification_id,n.title,n.message,JSON.stringify(n.context),n.priority]);
  await db.query("update public.quizlab_notifications set state='ready' where notification_id=$1 and state='queued'",[n.notification_id]);
  await db.query('update public.quizlab_notifications set next_check_at=$2 where notification_id=$1',[n.notification_id,new Date(clock().getTime()+60000)]);
  if(!p.pushEnabled||!p.categories[n.category]){await postpone(86400000,!p.pushEnabled?'push_disabled':'category_disabled');return;}if(s.active&&!policy.allowWhileActive){await postpone(90000,'active_app');return;}if(!core.deliveryWindow(p,clock(),windowOptions)){await waitWindow(p);return;}
  if(n.automatic&&!n.essential){const used=(await db.query("select n.notification_id,n.context,min(d.accepted_at) as first_sent from public.quizlab_notifications n join public.quizlab_notification_deliveries d using(notification_id) where n.user_id=$1 and n.automatic and not n.essential and d.accepted_at>=$2 and d.status in ('accepted','received','clicked') group by n.notification_id,n.context",[n.user_id,new Date(clock().getTime()-31*86400000)])).rows.filter(r=>r.notification_id!==n.notification_id);
   const day=core.localParts(clock(),p.timeZone).day;let todayCount=0;for(const row of used){const when=row.first_sent;if(when&&core.localParts(new Date(when),p.timeZone).day===day)todayCount++;}
   const sameToday=used.filter(r=>r.context.automation===n.context.automation&&r.first_sent&&core.localParts(new Date(r.first_sent),p.timeZone).day===day).length;
   if(todayCount>=2||sameToday>=(n.context.dailyLimit??2)){await postpone(900000,'daily_limit');return;}
   if(used.some(r=>r.context.automation===n.context.automation&&(!windowOptions.immediate||r.context.itemId&&r.context.itemId===n.context.itemId||r.context.badge&&r.context.badge===n.context.badge)&&clock()-new Date(r.first_sent)<(n.context.frequencyDays||1)*86400000)){await postpone(900000,'frequency_limit');return;}
  }
  const devices=(await db.query('select * from public.quizlab_notification_devices where user_id=$1 and enabled and permission=\'granted\' and subscription is not null',[n.user_id])).rows;
  if(!devices.length){await postpone(86400000,'no_device');return;}
  for(const d of devices){
   if(n.context.testDevice&&d.device_id!==n.context.testDevice)continue;
   if(!allowRealPush&&!sendPush)continue;
   // Another request may revoke a preference/account/device while a provider call is pending.
   const currentPrefs=(await prefs(n.user_id)).settings,currentSnapshot=await notificationSnapshot(n.user_id,currentPrefs,n);
   const currentDevice=(await db.query('select enabled,permission,subscription from public.quizlab_notification_devices where user_id=$1 and device_id=$2',[n.user_id,d.device_id])).rows[0];
   if(!currentDevice?.enabled||currentDevice.permission!=='granted'||!currentDevice.subscription||!currentPrefs.pushEnabled||!currentPrefs.categories[n.category]||currentSnapshot.active&&!policy.allowWhileActive||!core.deliveryWindow(currentPrefs,clock(),windowOptions))continue;
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
  const outcome=await deliveryState(n.notification_id);if(outcome)await db.query('update public.quizlab_notifications set push_state=$2,push_checked_at=$3 where notification_id=$1',[n.notification_id,outcome,clock()]);
 }
 async function unreadCount(user,studyAllowed,gradebookAllowed){if(typeof studyAllowed!=='boolean'||typeof gradebookAllowed!=='boolean'){const rights=await access(user);studyAllowed=!!rights.study;gradebookAllowed=!!rights.gradebook;}
  const unread=(await db.query("select count(*)::integer as count from public.quizlab_notifications where user_id=$1 and state='ready' and due_at<=$2 and (context->>'automation' is distinct from 'badge' or exists(select 1 from public.quizlab_study_badges sb where sb.user_id=$1 and sb.badge_key=quizlab_notifications.context->>'badge' and sb.evidence->>'verified'='true')) and read_at is null and archived_at is null and ($3 or category='service' or $4 and context->>'automation'='exam' and context->>'gradebookExam'='true')",[user,clock(),studyAllowed,gradebookAllowed])).rows[0].count;return{unread};}
 async function inbox(user,{offset=0,archived=false}={}){offset=num(Number(offset),0,1000000);if(!Number.isInteger(offset))throw fail(400,'Pagina non valida');const rights=await access(user),studyAllowed=!!rights.study;
  const rows=(await db.query("select notification_id,category,title,message,destination,essential,created_at,read_at,archived_at,push_state,push_checked_at from public.quizlab_notifications where user_id=$1 and state='ready' and due_at<=$2 and (context->>'automation' is distinct from 'badge' or exists(select 1 from public.quizlab_study_badges sb where sb.user_id=$1 and sb.badge_key=quizlab_notifications.context->>'badge' and sb.evidence->>'verified'='true')) and (archived_at is not null)=$3 and ($5 or category='service' or $6 and context->>'automation'='exam' and context->>'gradebookExam'='true') order by created_at desc limit 25 offset $4",[user,clock(),archived,offset,studyAllowed,!!rights.gradebook])).rows;
  const {unread}=await unreadCount(user,studyAllowed,!!rights.gradebook);return{rows,unread};}
 async function mark(user,input){if(!['read','unread','archive','restore','allRead'].includes(input.action))throw fail(400,'Azione non valida');if(input.action==='allRead'){await db.query("update public.quizlab_notifications set read_at=$2 where user_id=$1 and state='ready' and due_at<=$2 and read_at is null",[user,clock()]);}else{uuid(input.notification_id);const field=['archive','restore'].includes(input.action)?'archived_at':'read_at',value=['read','archive'].includes(input.action)?clock():null;await db.query('update public.quizlab_notifications set '+field+'=$3 where user_id=$1 and notification_id=$2 and state=\'ready\'',[user,input.notification_id,value]);}return{ok:true};}
 async function receipt(user,input){uuid(input.notification_id);if(!['received','clicked','session','review'].includes(input.event))throw fail(400,'Interazione non valida');const device=text(input.device_id,120),column=input.event==='clicked'?'clicked_at':'received_at';const r=await db.query("update public.quizlab_notification_deliveries set "+column+"=coalesce("+column+",$4),status=case when $5='clicked' then 'clicked' when status='clicked' then status else 'received' end where user_id=$1 and notification_id=$2 and device_id=$3 and status in ('accepted','received','clicked','sending') returning notification_id",[user,input.notification_id,device,clock(),input.event]);if(r.rows.length)await db.query("update public.quizlab_notifications set push_state='displayed',push_checked_at=$3 where user_id=$1 and notification_id=$2",[user,input.notification_id,clock()]);if(r.rows.length&&['session','review'].includes(input.event)){
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
 async function dashboard(user){await requireStudy(user);const p=await prefs(user),s=await snapshot(user,{details:true,interactive:true}),list=await items(user),goals=await goalPresentations(user,list,s,p.settings),j=await journey(user,list,s,p.settings);return{preferences:p,courses:s.courses.map(c=>({courseId:c.courseId,subject:c.subject,total:c.total,unique:c.unique,attemptCount:c.attemptCount,correct:c.correct,coverage:c.coverage,pending:pendingCount(c),avg5:c.avg5,reviewCount:reviewCount(c),review:c.review.slice(0,500)})),goals,exams:list.filter(i=>i.kind==='exam').map(i=>({...i,days:core.examDays(i.data,clock(),p.settings.timeZone)})),badges:j.badges,nextBadge:j.next,streak:s.streak,lastStudyAt:s.lastStudyAt,consolidatedAt:s.consolidatedAt,fresh:s.fresh,syncStatus:s.syncStatus};}
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
   const resolved=resolveCampaignTemplate({data:d,user:u,snapshot:s,preferences:p.settings,items:all,badges,now:clock(),goalCalculator:goalValue});
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
  await campaignsDue(started+60000);const users=(await db.query('select id from auth.users order by id limit 25 offset $1',[cursor])).rows;let processed=0;const changedUsers=new Set();
  for(const u of users){if(Date.now()-started>70000)break;try{if(await generate(u.id))changedUsers.add(u.id);}catch(e){await audit(null,'generation_failed',{userId:u.id,message:e.message});}processed++;}
  cursor=processed<users.length?cursor+processed:users.length===25?cursor+25:0;
  const due=(await db.query("select * from public.quizlab_notifications where state in ('queued','ready') and not delivery_cancelled and due_at<=$1 and expires_at>$1 and next_check_at<=$1 order by (state='queued') desc,next_check_at,priority desc,due_at limit 100",[clock()])).rows;
  for(const n of due){if(Date.now()-started>80000)break;const held=(await db.query("update quizlab_release_private.suite_scheduler set lease_until=now()+interval '110 seconds' where singleton and owner=$1 returning owner",[owner])).rows.length;if(!held)break;try{await dispatch(n,{revalidate:changedUsers.has(n.user_id)});}catch(e){await audit(null,'dispatch_failed',{id:n.notification_id,message:e.message});}}
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
   totals.achieved_current_period+=(await items(u.id,'goal')).filter(i=>goalValue(i.data,s,clock(),p.timeZone).status==='achieved').length;
   if(s.lastStudyAt)totals.study_resume_after_inactivity+=Number((await db.query("select count(distinct n.notification_id) as n from public.quizlab_notifications n join public.quizlab_notification_deliveries d using(notification_id) where n.user_id=$1 and n.context->>'automation'='inactivity' and d.clicked_at is not null and d.clicked_at<$2 and d.clicked_at>$3",[u.id,s.lastStudyAt,new Date(Date.parse(s.lastStudyAt)-7*86400000)])).rows[0].n);
  }
  return{totals,automations:await automationRows(),campaigns:(await db.query('select * from public.quizlab_notification_campaigns order by updated_at desc limit 25 offset $1',[offset])).rows,
   deliveries:(await db.query('select d.notification_id,d.device_id,d.status,d.attempts,d.provider_status,d.failure,d.accepted_at,d.received_at,d.clicked_at,n.title,n.created_at from public.quizlab_notification_deliveries d join public.quizlab_notifications n using(notification_id) order by coalesce(d.accepted_at,d.attempt_started_at,n.created_at) desc,d.notification_id desc limit 25 offset $1',[offset])).rows,
   waiting:(await db.query("select notification_id,title,state,push_state,push_checked_at,due_at,next_check_at,context->>'automation' as automation from public.quizlab_notifications where read_at is null and archived_at is null and state in ('queued','ready') order by created_at desc limit 25 offset $1",[offset])).rows,
   audit:(await db.query('select audit_id,action,detail,at from public.quizlab_notification_audit order by at desc limit 25 offset $1',[offset])).rows,
   users:await directoryUsers(),realPushEnabled:allowRealPush,scope:'Account UniSgiunglaLab autorizzati',measurement:'Conferme del provider e segnali dei client sono distinti. Obiettivi: periodo attuale nei dati consolidati. Ripresa dopo inattività: studio entro 7 giorni da un clic, associazione temporale senza attribuzione causale.'};
 }
 async function summary(user){
  const preference=await prefs(user),a=await access(user),notifications=await unreadCount(user,!!a.study,!!a.gradebook);let overview=null;
  if(a.study){const s=await snapshot(user),all=await items(user),goals=(await goalPresentations(user,all,s,preference.settings)).map(i=>i.progress),j=await journey(user,all,s,preference.settings);
   const exams=all.filter(i=>i.kind==='exam'&&!i.data.cancelled&&core.examDays(i.data,clock(),preference.settings.timeZone)>=0).sort((x,y)=>x.data.date.localeCompare(y.data.date)||String(x.data.time||'').localeCompare(String(y.data.time||'')));
   const e=exams[0],c=e?s.courses.find(c=>c.courseId===e.data.courseId):null;
   overview={badges:j.badges.slice(0,3),badgeCount:j.badges.length,nextBadge:j.next,streak:s.streak,activeGoals:goals.filter(g=>g.status==='active').length,achievedGoals:goals.filter(g=>g.status==='achieved').length,consolidatedAt:s.consolidatedAt,
    nextExam:e&&c?{...e.data,subject:c.subject,days:core.examDays(e.data,clock(),preference.settings.timeZone),coverage:c.coverage}:null};
  }return{preferences:preference,unread:notifications.unread,overview};
 }
 return{prefs,savePreferences,snapshot,saveItem,registerDevice,heartbeat,listDevices,revokeDevice,dashboard,inbox,unread:unreadCount,mark,receipt,saveDiagnostics,testPush,automationRows,saveAutomation,campaignOptions,preview,saveCampaign,report,summary,tick,generate,dispatch,enqueue,
  tickPending:()=>tickPromise||Promise.resolve(),publicConfig:()=>({publicKey:vapid.publicKey,realPushEnabled:allowRealPush,testOnly:false})};
}
