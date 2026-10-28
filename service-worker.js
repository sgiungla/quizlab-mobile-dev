/* Shared derived metrics. Does not mutate bank/progress or change QuizLab grading. */
(function(root){
 'use strict';
 const dayMs=86400000;
 const defaults=()=>({pushEnabled:false,showPushContent:false,categories:{study:true,progress:true,service:true,marketing:false},marketingConsent:false,
  reminderTime:'19:00',quietStart:'22:00',quietEnd:'08:00',timeZone:'Europe/Rome',studyDays:[1,2,3,4,5,6,0],inactivityDays:3,countdowns:true,courseIds:[],pausedCourseIds:[]});
 function pushPresentation(data,showContent=false){
  const generic={title:'QuizLab · '+(data.category==='service'?'Comunicazione di servizio':'Un nuovo promemoria'),body:'Apri QuizLab per leggere il messaggio.'};
  // Both the current account choice and the sender's explicit flag must permit content.
  if(showContent!==true||data.contentVisible!==true)return generic;
  const excerpt=(value,limit,fallback)=>{
   if(typeof value!=='string'||!value.trim())return fallback;
   const points=Array.from(value.trim());return points.length>limit?points.slice(0,limit).join('')+'…':points.join('');
  };
  return{title:excerpt(data.title,120,generic.title),body:excerpt(data.body,300,generic.body)};
 }
 const dateFormatters=new Map();
 function localParts(date,zone='Europe/Rome'){
  let formatter=dateFormatters.get(zone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(dateFormatters.size>=32)dateFormatters.delete(dateFormatters.keys().next().value);dateFormatters.set(zone,formatter);}
  const p=Object.fromEntries(formatter.formatToParts(date).map(x=>[x.type,x.value]));
  const key=p.year+'-'+p.month+'-'+p.day;return{day:key,minute:Number(p.hour)*60+Number(p.minute),weekday:new Date(key+'T12:00:00Z').getUTCDay()};
 }
 const dayNumber=d=>Date.parse(d+'T00:00:00Z')/dayMs;
 const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
 function deliveryWindow(p,now,{automatic=true,urgent=false,immediate=false}={}){
  const x=localParts(now,p.timeZone),a=minutes(p.quietStart),b=minutes(p.quietEnd);
  if(a!==b&&(a<b?x.minute>=a&&x.minute<b:x.minute>=a||x.minute<b))return false;
  if(automatic&&!urgent&&(!p.studyDays.includes(x.weekday)||!immediate&&x.minute<minutes(p.reminderTime)))return false;
  return true;
 }
 function inQuietHours(p,now){const x=localParts(now,p.timeZone),a=minutes(p.quietStart),b=minutes(p.quietEnd);return a!==b&&(a<b?x.minute>=a&&x.minute<b:x.minute>=a||x.minute<b);}
 function nextDeliveryAt(p,now,options={}){
  if(deliveryWindow(p,now,options))return new Date(now);
  if(options.automatic!==false&&!options.urgent&&!p.studyDays.length)return null;
  const start=Math.floor(now.getTime()/60000)*60000;
  for(let minute=1;minute<=8*24*60;minute++){const at=new Date(start+minute*60000);if(deliveryWindow(p,at,options))return at;}
  return null;
 }
 const validDate=v=>!!v&&Number.isFinite(Date.parse(v));
 function summarize(rows,now=new Date(),zone='Europe/Rome'){
  const today=localParts(now,zone).day,courses=[],studyDates=new Set();let lastStudyAt=null,nextReviewAt=null;
  for(const row of rows){
   const bank=row.bank_json||{},progress=row.progress_json||{},meta=progress.syncMeta||{},reset=meta.performanceResetAt;
   const questions=[...(bank.officialBank||[]),...(bank.aiBank||[])],ids=new Set(questions.map(q=>String(q.id))),officialIds=new Set((bank.officialBank||[]).map(q=>String(q.id))),events=new Map();
   for(const a of progress.attempts||[]){
    if(!a||!ids.has(String(a.questionId))||!validDate(a.at)||Date.parse(a.at)>now.getTime()||(reset&&Date.parse(a.at)<Date.parse(reset))||a.answered===false||a.answer===null||typeof a.correct!=='boolean')continue;
    const key=a.eventId||JSON.stringify([a.questionId,a.at,a.mode,a.answer,a.correct,a.elapsedMs]);
    if(!events.has(key))events.set(key,{...a,at:new Date(a.at).toISOString()});
   }
   const attempts=[...events.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at))||String(a.eventId||'').localeCompare(String(b.eventId||''))),latest=new Map();
   for(const a of attempts){latest.set(String(a.questionId),a);studyDates.add(localParts(new Date(a.at),zone).day);if(!lastStudyAt||a.at>lastStudyAt)lastStudyAt=a.at;}
   const pending=(progress.pendingReview||[]).map(String).filter(id=>ids.has(id)),seen=new Set(attempts.map(a=>String(a.questionId))),correct=attempts.filter(a=>a.correct).length;
   const examsMap=new Map();for(const e of progress.exams||[]){if(!e||e.grade==null||typeof e.grade==='string'&&!e.grade.trim()||!validDate(e.at)||Date.parse(e.at)>now.getTime()||(meta.examResetAt&&Date.parse(e.at)<Date.parse(meta.examResetAt))||!Number.isFinite(Number(e.grade))||Number(e.grade)<0||Number(e.grade)>30)continue;examsMap.set(e.eventId||JSON.stringify([e.at,e.grade,e.questionIds,e.elapsedMs]),{...e,at:new Date(e.at).toISOString()});}
   const exams=[...examsMap.values()].sort((a,b)=>String(a.at).localeCompare(String(b.at))),last5=exams.slice(-5),previous5=exams.length>=10?exams.slice(-10,-5):[],average=list=>list.length?list.reduce((n,e)=>n+Number(e.grade),0)/list.length:null;
   const histories=new Map(),pendingSet=new Set(pending);for(const a of attempts){const key=String(a.questionId);if(!histories.has(key))histories.set(key,[]);histories.get(key).push(a);}
   const review=questions.map(q=>{
    const hist=histories.get(String(q.id))||[],wrong=hist.filter(a=>!a.correct).length,last=hist.at(-1),unresolved=pendingSet.has(String(q.id));
    // Recovery still follows the existing pendingReview policy. Periodic review
    // is additive: 1/3/7/14/30 days after consecutive correct responses.
    let successes=0;for(let i=hist.length-1;i>=0&&hist[i].correct;i--)successes++;
    const interval=[1,3,7,14,30][Math.min(4,Math.max(0,successes-1))],elapsed=last?(now-Date.parse(last.at))/dayMs:0;
    const next=last?new Date(Date.parse(last.at)+interval*dayMs).toISOString():null;if(next&&Date.parse(next)>now&&(!nextReviewAt||next<nextReviewAt))nextReviewAt=next;
    return{questionId:q.id,unresolved,wrong,periodic:!!last&&!unresolved&&last.correct&&elapsed>=interval,priority:(unresolved?1000:0)+Math.min(wrong,20)*30+Math.min(30,Math.floor(elapsed)),nextReviewAt:last?new Date(Date.parse(last.at)+interval*dayMs).toISOString():null};
   }).filter(q=>q.unresolved||q.periodic).sort((a,b)=>b.priority-a.priority||String(a.questionId).localeCompare(String(b.questionId)));
   courses.push({courseId:row.course_id,subject:row.subject,total:ids.size,official:officialIds.size,unique:seen.size,officialUnique:[...seen].filter(id=>officialIds.has(id)).length,
    attempts,attemptCount:attempts.length,correct,accuracy:attempts.length?correct/attempts.length*100:null,exams,avg5:average(last5),previousAvg5:average(previous5),averageImprovement:previous5.length?average(last5)-average(previous5):null,
    pending:[...new Set(pending)],review,recoveredAll:!pending.length&&[...histories.values()].some(h=>h.some(a=>!a.correct))&&[...histories.values()].every(h=>!h.some(a=>!a.correct)||h.at(-1)?.correct===true),coverage:ids.size?seen.size/ids.size*100:0});
  }
  let streak=0,day=dayNumber(today);if(!studyDates.has(today))day--;while(studyDates.has(new Date(day*dayMs).toISOString().slice(0,10))){streak++;day--;}
  return {courses,lastStudyAt,nextReviewAt,streak,today,studyDates:[...studyDates].sort(),computedAt:now.toISOString()};
 }
 function periodBounds(goal,now,zone){
  const today=localParts(now,zone).day;let start=goal.startDate||today,end=goal.deadline||'9999-12-31',periodKey=goal.startDate||'all';
  if(goal.metric==='recovery')return{start,end,periodKey:'recovery:'+start};
  if(goal.period==='daily'){start=today;end=today;periodKey=today;}
  if(goal.period==='weekly'){const weekday=(new Date(today+'T12:00Z').getUTCDay()+6)%7;start=new Date((dayNumber(today)-weekday)*dayMs).toISOString().slice(0,10);end=new Date((dayNumber(start)+6)*dayMs).toISOString().slice(0,10);periodKey=start;}
  return{start,end,periodKey};
 }
 function goalValue(goal,snapshot,now=new Date(),zone='Europe/Rome'){
  const {start,end,periodKey}=periodBounds(goal,now,zone),courses=snapshot.courses.filter(c=>!goal.courseId||c.courseId===goal.courseId);
  const attempts=courses.flatMap(c=>c.attempts.map(a=>({...a,courseId:c.courseId}))).filter(a=>{const day=localParts(new Date(a.at),zone).day;return day>=start&&day<=end;});
  const exams=courses.flatMap(c=>c.exams).filter(e=>{const day=localParts(new Date(e.at),zone).day;return day>=start&&day<=end;}).sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-5);
  let value=0,denominator=attempts.length,valid=true;
  switch(goal.metric){
   case 'unique':value=new Set(attempts.map(a=>a.courseId+'\u0000'+a.questionId)).size;break;
   case 'attempts':value=attempts.length;break;
   case 'correct':value=attempts.filter(a=>a.correct).length;break;
   case 'accuracy':valid=denominator>=goal.minSample;value=denominator?attempts.filter(a=>a.correct).length/denominator*100:0;break;
   case 'coverage':case 'officialCoverage':{
    denominator=courses.reduce((n,c)=>n+(goal.metric==='coverage'?c.total:c.official),0);
    value=denominator?courses.reduce((n,c)=>n+(goal.metric==='coverage'?c.unique:c.officialUnique),0)/denominator*100:0;valid=denominator>0;break;}
   case 'examAverage':denominator=exams.length;valid=denominator>=goal.minSample;value=denominator?exams.reduce((n,e)=>n+Number(e.grade),0)/denominator:0;break;
   case 'recovery':{const baseline=goal.baseline||[];denominator=baseline.length;const pending=new Set(courses.flatMap(c=>c.pending.map(q=>c.courseId+'\u0000'+q)));value=baseline.filter(q=>!pending.has(q)&&courses.some(c=>c.courseId===q.split('\u0000')[0]&&c.attempts.filter(a=>String(a.questionId)===q.split('\u0000')[1]).at(-1)?.correct===true)).length;valid=baseline.length>0;break;}
   case 'streak':value=snapshot.streak;denominator=value;break;
  }
  const target=goal.metric==='recovery'?denominator:goal.target,percent=valid&&target?Math.min(100,value/target*100):0;
  const expired=!!goal.deadline&&localParts(now,zone).day>goal.deadline;
  return{value:Math.round(value*100)/100,target,percent:Math.round(percent*10)/10,remaining:Math.max(0,Math.round((target-value)*100)/100),sample:denominator,valid,
   status:goal.paused?'paused':goal.startDate&&localParts(now,zone).day<goal.startDate?'scheduled':valid&&value>=target?'achieved':expired?'expired':'active',periodKey};
 }
 function examDays(exam,now,zone){return Math.round(dayNumber(exam.date)-dayNumber(localParts(now,zone).day));}
 const core={defaults,pushPresentation,localParts,deliveryWindow,inQuietHours,nextDeliveryAt,summarize,goalValue,examDays,dayNumber};
 root.QuizLabStudyCore=core;if(typeof module!=='undefined'&&module.exports)module.exports=core;
})(typeof globalThis==='undefined'?this:globalThis);

const CACHE='quizlab-v0.11.28-r11';
const ROOT=new URL('./',self.location.href);
const INDEX=new URL('./index.html',ROOT).href;
const MANIFEST=new URL('./asset-manifest.json',ROOT).href;
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
let assets=null;
const assetUrls=async()=>{
 if(assets)return assets;
 const cache=await caches.open(CACHE),manifest=await cache.match(MANIFEST);
 if(!manifest)return new Set();
 const data=await manifest.json();assets=new Set(data.assets.map(x=>new URL(x,ROOT).href));assets.add(MANIFEST);return assets;
};
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const manifestRequest=new URL(MANIFEST);manifestRequest.searchParams.set('build',CACHE+'-'+Date.now());
 const response=await fetch(manifestRequest,{cache:'no-store'});if(!response.ok)throw Error('Release manifest unavailable');
 const data=await response.clone().json();if(data.version!=='0.11.28'||!Array.isArray(data.assets)||!data.sha256)throw Error('Incoherent release');
 const urls=data.assets.map(x=>new URL(x,ROOT));if(urls.some(u=>u.origin!==ROOT.origin||!u.href.startsWith(ROOT.href)))throw Error('Invalid asset path');
 const validated=[];
 // Validate every byte before exposing this release. A cached CDN response from
 // the previous deployment must not produce a mixed page/module installation.
 for(let offset=0;offset<urls.length;offset+=6){
  const batch=await Promise.all(urls.slice(offset,offset+6).map(async u=>{
   const relative='./'+u.pathname.slice(ROOT.pathname.length),key=relative==='./'?'./index.html':relative;
   const expected=data.sha256[key];if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('Missing asset digest');
   let asset,body;
   if(key.endsWith('.html')){
    // Some HTTPS intermediaries inject scripts or transcode HTML responses.
    // Build the shell from the release's JSON payload, retaining the same
    // mandatory digest. Never strip scripts or accept altered HTML bytes.
    const encoded=data.html?.[key];
    if(typeof encoded!=='string'||encoded.length>1400000||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw Error('Missing HTML release payload');
    body=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    asset=new Response(body,{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
   }else{
    const versioned=new URL(u.href);versioned.searchParams.set('sha256',expected);
    asset=await fetch(new Request(versioned.href,{cache:'reload'}));if(!asset.ok||asset.type==='opaque')throw Error('Asset unavailable');
    body=await asset.clone().arrayBuffer();
   }
   const actual=hex(await crypto.subtle.digest('SHA-256',body));
   if(actual!==expected)throw Error('Asset digest mismatch');
   return [u.href,asset];
  }));validated.push(...batch);
 }
 const cache=await caches.open(CACHE);for(const [url,asset] of validated)await cache.put(url,asset);await cache.put(MANIFEST,response);
 // An existing page stays on its coherent cached release until its update manager has saved it.
})().catch(async error=>{
 const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 for(const client of clients)if(client.url.startsWith(ROOT.href))client.postMessage({type:'QUIZLAB_UPDATE_FAILED',code:String(error?.message||'Installazione non riuscita').slice(0,120)});
 throw error;
})));
self.addEventListener('message',event=>{if(event.data?.type==='QUIZLAB_ACTIVATE_UPDATE'&&event.source?.url?.startsWith(ROOT.href))event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 await self.clients.claim();
 const keys=await caches.keys();await Promise.all(keys.filter(k=>k!==CACHE&&(k.startsWith('quizlab-v')||k.startsWith('quizlab-static-')||k.startsWith('quizlab-mobile-dev-v'))).map(k=>caches.delete(k)));
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==ROOT.origin||!url.href.startsWith(ROOT.href))return;
 if(url.pathname.endsWith('/service-worker.js')||url.pathname.endsWith('/release.json'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),urls=await assetUrls();
  const key=request.mode==='navigate'?(urls.has(url.origin+url.pathname)?url.origin+url.pathname:INDEX):url.origin+url.pathname;
  if(!urls.has(key))return fetch(request);
  // Static files belonging to an activated release are served only from its
  // verified cache. Missing files must not fall through to another deployment.
  return await cache.match(key)||new Response('Aggiornamento incompleto. Riapri QuizLab quando la rete è disponibile.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
 })());
});

// Separate durable transport evidence, never tokens or study documents.
function pushDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open('quizlab-push-evidence',1);r.onupgradeneeded=()=>{r.result.createObjectStore('events',{keyPath:'key'});r.result.createObjectStore('policy');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function pushStore(name,mode,fn){const db=await pushDb();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name,mode);let value;const req=fn(tx.objectStore(name));req.onsuccess=()=>{value=req.result;};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}}
async function recordPush(data,event){
 const value={key:data.id+':'+event,event,notification_id:data.id,device_id:data.deviceId,userId:data.userId,at:new Date().toISOString()};
 await pushStore('events','readwrite',s=>s.put(value));
 let windows=[];try{windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});}catch{return;}
 // A tab may disappear after matchAll. Evidence is already durable; one stale
 // client must not prevent notifying the remaining pages or opening the app.
 for(const client of windows)try{client.postMessage({type:'QUIZLAB_PUSH_EVIDENCE'});}catch{}
}
async function prunePushEvidence(){const events=await pushStore('events','readonly',s=>s.getAll()),cutoff=Date.now()-30*86400000;for(const old of events.filter(e=>Date.parse(e.at)<cutoff).slice(0,500))await pushStore('events','readwrite',s=>s.delete(old.key));}
const RECEIVER_VERSION='lab-push-diagnostics-1';
async function diagnosePush(data,stage,error){
 try{
  const key=data.id+':diagnostic',old=await pushStore('events','readonly',s=>s.get(key));
  if(old?.stage==='displayed')return;
  const errorName=['NotAllowedError','SecurityError','TypeError','NetworkError','AbortError','InvalidStateError','QuotaExceededError'].includes(error?.name)?error.name:error?'Error':null;
  await pushStore('events','readwrite',s=>s.put({key,notification_id:data.id,userId:data.userId,device_id:data.deviceId,stage,error:errorName,arrivedAt:old?.arrivedAt||new Date().toISOString(),at:new Date().toISOString()}));
 }catch{console.warn('QuizLab: diagnostica del ricevitore non disponibile.');}
}
self.addEventListener('push',event=>{event.waitUntil((async()=>{
 let data;try{data=event.data.json();}catch{return;}
 if(!/^[0-9a-f-]{36}$/i.test(data?.id||'')||typeof data.deviceId!=='string'||typeof data.userId!=='string'||!['study','progress','service','marketing'].includes(data.category))return;
 await diagnosePush(data,'arrived');
 try{
 const policy=await pushStore('policy','readonly',s=>s.get('current'));
 const blocked=!policy?'no_policy':policy.userId!==data.userId?'wrong_account':!policy.settings?.pushEnabled?'push_disabled':!policy.settings?.categories?.[data.category]?'category_disabled':data.category==='marketing'&&!policy.settings.marketingConsent?'marketing_consent':null;
 if(blocked){await diagnosePush(data,blocked);return;}
 const old=await pushStore('events','readonly',s=>s.get(data.id+':seen'));if(old){await diagnosePush(data,'duplicate');return;}
 if(!self.QuizLabStudyCore.deliveryWindow(policy.settings,new Date(),{automatic:false})){await diagnosePush(data,'quiet_hours');return;}
 const url=new URL(data.url||'./?study=inbox',self.registration.scope);if(url.origin!==self.location.origin||!url.href.startsWith(self.registration.scope)){await diagnosePush(data,'invalid_destination');return;}
 try{await pushStore('events','readwrite',s=>s.add({key:data.id+':seen',userId:data.userId,at:new Date().toISOString()}));}catch(error){if(error?.name==='ConstraintError')return;throw error;}
 const presentation=self.QuizLabStudyCore.pushPresentation(data,policy.settings.showPushContent===true);
 // Keep only navigation/evidence metadata; hidden message text is not stored in notification data.
 const metadata={id:data.id,userId:data.userId,deviceId:data.deviceId,category:data.category,url:url.href};
 await self.registration.showNotification(presentation.title,{body:presentation.body,icon:new URL('./icons/quizlab-sgiungla-192.png',self.registration.scope).href,tag:'quizlab:'+data.id,data:metadata});
 await diagnosePush(data,'displayed');
 await recordPush(data,'received');
 }catch(error){await diagnosePush(data,'receiver_error',error);throw error;}
})());});
async function openPushDestination(url){
 let windows=[];try{windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});}catch{}
 for(const client of windows.filter(c=>c.frameType!=='nested'&&c.url.startsWith(self.registration.scope))){
  try{
   // Navigation replaces the WindowClient. Focus the returned live client,
   // rather than the old document, which may now be inactive.
   const navigated=await client.navigate(url.href);
   if(!navigated)continue;
   await navigated.focus();return;
  }catch{}
 }
 await self.clients.openWindow(url.href);
}
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{
 const data=event.notification.data;if(!data?.id)return;
 let url;try{url=new URL(data.url,self.registration.scope);}catch{return;}
 if(url.origin!==self.location.origin||!url.href.startsWith(self.registration.scope))return;
 url.searchParams.set('notification',data.id);url.searchParams.set('pushDevice',data.deviceId);
 // Bookkeeping must not delay or prevent the user's navigation. A failed
 // receipt write is not presented as a recorded click.
 const evidence=recordPush(data,'clicked').catch(()=>console.warn('QuizLab: impossibile salvare il segnale di clic.'));
 try{await openPushDestination(url);}finally{await evidence;}
})());});
self.addEventListener('message',event=>{const m=event.data;if(!m||!event.source?.url?.startsWith(self.registration.scope))return;
 if(m.type==='QUIZLAB_PUSH_POLICY')event.waitUntil((async()=>{await pushStore('policy','readwrite',s=>s.put({userId:m.userId||null,settings:m.settings||null},'current'));await prunePushEvidence();})());
 if(m.type==='QUIZLAB_PUSH_EVIDENCE_READ')event.waitUntil((async()=>{const events=await pushStore('events','readonly',s=>s.getAll());event.ports[0]?.postMessage(events.filter(e=>e.userId===m.userId&&e.event).slice(0,100));})());
 if(m.type==='QUIZLAB_PUSH_DIAGNOSTICS_READ')event.waitUntil((async()=>{
  const events=await pushStore('events','readonly',s=>s.getAll());
  event.ports[0]?.postMessage({receiverVersion:RECEIVER_VERSION,rows:events.filter(e=>e.userId===m.userId&&e.key.endsWith(':diagnostic')).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,15).map(({notification_id,stage,error,arrivedAt,at})=>({notification_id,stage,error,arrivedAt,at}))});
 })());
 if(m.type==='QUIZLAB_PUSH_EVIDENCE_ACK')event.waitUntil((async()=>{for(const key of (m.keys||[]).slice(0,100)){const old=await pushStore('events','readonly',s=>s.get(key));if(old?.userId===m.userId&&old.event)await pushStore('events','readwrite',s=>s.delete(key));}})());
});
