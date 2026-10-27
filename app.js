import {installUpdates,restoreUpdateCheckpoint} from './update-manager.mjs';
import './egress-ui.js';
import {loadStore,saveStore,emptyStore,workspaceMigrationInfo,selectWorkspace,currentWorkspaceKey} from './db.js';
import {QuizLabSyncAdapter} from './sync-adapter.js';
import {DEFAULT_CLOUD_CONFIG} from './cloud-config.js';
import './study-core.js';
import './list-navigation.js';
import './study-ui.js';
import {syncPushEvidence} from './push-evidence.js';
import {collectPushDiagnostics} from './push-diagnostics.js';
import {createAdminUserListState,adminUserPageRequest,applyAdminUserPage,readAdminUserFilters,updateAdminUserFilters,resetAdminUserFilters,renderAdminUserList,adminEffectiveStatus} from './admin-user-list.js';

const BANK_SCHEMA='unisgiunglalab.quizlab.bank';
const BACKUP_SCHEMA='unisgiunglalab.quizlab.backup';
const APP_VERSION='0.11.28';
const sync=new QuizLabSyncAdapter();
const app=document.getElementById('app');
const picker=document.getElementById('filePicker');
let store=emptyStore();
let route={name:'home',courseId:null};
let session=null;
let toastTimer=null;
let examTimer=null;
let cloudState={status:'local-only',user:null};
let accessState={status:'active',isAdmin:false,legacy:true};
let adminData={users:[],storage:null,courses:[],retiredCourses:[],plans:[],loaded:false};
let adminUsers=null,adminPageRequestId=0;
let adminPendingCount=0;
let autoSyncTimer=null;
let syncInFlight=false;
let syncQueuedManual=false;
let lastSyncError=false;
let explicitAuthIntent=false;
let guestDataPending=false;
let workspaceGeneration=0;
let syncRunId=0;
let localCourseSaveSerial=0;
let searchLimit=30;
let studyTelemetryAt=0,studyTelemetryClean=null;
let studyOverview=null,studyBackgroundBusy=false,studyOverviewUser=null;
async function studyRequest(path,body){
 const userId=cloudState.user?.id;if(!userId||!sync.client)throw new Error('Accedi al tuo account UniSgiunglaLab');
 const result=await sync.client.auth.getSession(),token=result.data?.session?.access_token;
 if(!token)throw new Error('Verifica online necessaria per questa operazione');
 const config=globalThis.QUIZLAB_LAB_CONFIG;
 if(config?.mode!=='production'||!config.suiteBase)throw new Error('Modulo studio non configurato');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetch(config.suiteBase+'/study/'+path,{method:body===undefined?'GET':'POST',signal:controller.signal,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json();
  if(userId!==cloudState.user?.id)throw new Error('Account cambiato');if(!response.ok)throw Object.assign(new Error(value.message||'Operazione non riuscita'),{status:response.status});return value;
 }finally{clearTimeout(timer);}
}
async function studyHeartbeat(){
 if(globalThis.QUIZLAB_LAB_CONFIG?.studyEnabled===false)return;
 if(!cloudState.user||!navigator.onLine)return;const clean=!(store.sync?.dirtyCourseIds?.length||store.sync?.dirtyBankCourseIds?.length);
 if(studyTelemetryClean===clean&&Date.now()-studyTelemetryAt<45000)return;studyTelemetryClean=clean;studyTelemetryAt=Date.now();
 try{await studyRequest('heartbeat',{device_id:store.sync.clientId,clean,active:document.visibilityState==='visible'});}catch{}
}
async function refreshStudyBell(){
 if(globalThis.QUIZLAB_LAB_CONFIG?.studyEnabled===false)return;
 if(!cloudState.user||!navigator.onLine)return;
 try{const value=await studyRequest('unread');for(const el of document.querySelectorAll('[data-study-unread]'))el.textContent=value.unread?'('+value.unread+')':'';}catch{}
}
async function openStudyPanel(tab='goals'){
 if(!cloudState.user)throw new Error('Accedi prima al tuo account UniSgiunglaLab');studyHeartbeat().catch(()=>{});
 return globalThis.QuizLabStudyUI.open({host:document.body,request:studyRequest,accountId:cloudState.user.id,deviceId:store.sync.clientId,tab,theme:currentTheme,platform:'pwa',currentAccount:()=>cloudState.user?.id,canStudy:featuresAllowed,onChange:()=>studyRefreshBackground().catch(()=>{}),pushDiagnostics:()=>collectPushDiagnostics(cloudState.user.id),
  navigate:({courseId,questionIds})=>{if(!featuresAllowed()||!store.courses[courseId])return;route={name:'dashboard',courseId};const c=course();const ids=questionIds?.length?questionIds:c.pendingReview;const by=new Map(qbank(c).map(q=>[q.id,q]));if(ids.length){startSession(ids.map(id=>by.get(id)).filter(Boolean),'Ripasso intelligente','review');if(session){session.reviewPolicy='clear-on-correct';recordStudyReviewFromNotification();}}else render();}});
}
async function studyRefreshBackground(){
 if(globalThis.QUIZLAB_LAB_CONFIG?.studyEnabled===false)return;
 if(studyBackgroundBusy||!cloudState.user||!navigator.onLine)return;studyBackgroundBusy=true;
 try{await studyHeartbeat();const id=cloudState.user.id,value=await studyRequest('summary');if(cloudState.user?.id!==id)return;
  studyOverview=value.overview;studyOverviewUser=id;
  for(const el of document.querySelectorAll('[data-study-unread]'))el.textContent=value.unread?'('+value.unread+')':'';
  for(const el of document.querySelectorAll('[data-study-summary]'))el.innerHTML=studySummaryHtml();
  await syncPushEvidence(id,studyRequest,value.preferences);
 }catch{}finally{studyBackgroundBusy=false;}
}
function studySummaryHtml(){
 if(!cloudState.user||studyOverviewUser!==cloudState.user.id||!studyOverview)return '';
 const o=studyOverview,e=o.nextExam;
 return '<section class="card"><div class="eyebrow">Il tuo percorso</div><p>'+o.activeGoals+' obiettivi in corso · '+o.achievedGoals+' raggiunti · '+o.streak+' giorni consecutivi</p>'+(e?'<h3>Prossimo esame: '+esc(e.subject)+'</h3><p>'+esc(e.date)+' · '+e.days+' giorni · Copertura sincronizzata '+Number(e.coverage).toLocaleString('it-IT',{maximumFractionDigits:1})+'%</p><p>'+esc(e.preparation)+'</p>':'<p>Aggiungi obiettivi e date degli esami per organizzare lo studio.</p>')+'<button class="btn secondary" data-action="study-panel">Apri il tuo percorso</button></section>';
}
globalThis.addEventListener?.('quizlab-study-refresh',()=>studyRefreshBackground());
if('serviceWorker'in navigator)navigator.serviceWorker.addEventListener?.('message',event=>{if(event.data?.type==='QUIZLAB_PUSH_EVIDENCE')studyRefreshBackground().catch(()=>{});});
setInterval(()=>{if(document.visibilityState==='visible'&&cloudState.user)studyRefreshBackground().catch(()=>{});},60000);
async function openStudyFromLocation(){
 const params=new URLSearchParams(location.search),tab=params.get('study'),notification=params.get('notification'),device=params.get('pushDevice');
 if(!tab||!cloudState.user)return;
 if(/^[0-9a-f-]{36}$/i.test(notification||'')&&device)try{await studyRequest('receipt',{notification_id:notification,device_id:device,event:'session'});}catch{}
 await openStudyPanel(['goals','exams','inbox','preferences','review','badges'].includes(tab)?tab:'inbox');
}
function recordStudyReviewFromNotification(){const p=new URLSearchParams(location.search);if(/^[0-9a-f-]{36}$/i.test(p.get('notification')||'')&&p.get('pushDevice'))studyRequest('receipt',{notification_id:p.get('notification'),device_id:p.get('pushDevice'),event:'review'}).catch(()=>{});}

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
const now=()=>new Date().toISOString();
const newEventId=()=>{try{return crypto.randomUUID();}catch(e){return 'evt_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);}};
const uniq=a=>[...new Set((a||[]).filter(Boolean))];
const shuffle=a=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
const qbank=c=>[...(c?.officialBank||[]),...(c?.aiBank||[])];
const clamp=(n,a,b)=>Math.min(b,Math.max(a,Number(n)||0));
const gradeFromRatio=(correct,total)=>total?Math.round((correct/total)*300)/10:0;
const fmtGrade=v=>Number.isFinite(Number(v))?(Number.isInteger(clamp(v,0,30))?clamp(v,0,30)+'/30':clamp(v,0,30).toFixed(1).replace('.',',')+'/30'):'—';
const fmtDuration=ms=>{const t=Math.max(0,Math.floor((Number(ms)||0)/1000)),m=Math.floor(t/60),sec=t%60;return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');};
function fmtBytes(n){
 const v=Number(n)||0;
 if(v<1024)return v+' B';
 if(v<1024*1024)return (v/1024).toFixed(1).replace('.',',')+' KB';
 if(v<1024*1024*1024)return (v/1024/1024).toFixed(1).replace('.',',')+' MB';
 return (v/1024/1024/1024).toFixed(2).replace('.',',')+' GB';
}

function fmtSyncAgo(iso){
 if(!iso)return '';
 const t=new Date(iso).getTime();if(!Number.isFinite(t))return '';
 const sec=Math.max(0,Math.floor((Date.now()-t)/1000));
 if(sec<45)return 'ora';
 if(sec<3600)return Math.floor(sec/60)+' min fa';
 const d=new Date(t),today=new Date();
 if(d.toDateString()===today.toDateString())return 'oggi '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
 return d.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit'})+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function cloudRetryState(){
 const value=store.sync?.cloudRetry;
 if(!value||value.ownerId!==cloudState.user?.id)return {failures:0,nextRetryAt:0,status:0,unavailable:false,code:null};
 const retry=Number(value.nextRetryAt)||0;
 if(retry>Date.now()+900000||retry<0)return {failures:0,nextRetryAt:0,status:0,unavailable:false,code:null};
 return {failures:Math.min(20,Math.max(0,Number(value.failures)||0)),nextRetryAt:retry,status:Number(value.status)||0,unavailable:value.unavailable===true,code:value.code==='SYNC_NOT_CONVERGED'?'SYNC_NOT_CONVERGED':null};
}
function cloudRetryBlocked(){
 const state=cloudRetryState();
 const license=globalThis.UniSgiunglaLicense?.status?.()||{};
 const licenseRetry=license.cloudUnavailable?Date.parse(license.nextRetryAt)||0:0;
 return Date.now()<Math.max(state.nextRetryAt,licenseRetry);
}
function cloudUnavailable(){return cloudRetryState().unavailable||globalThis.UniSgiunglaLicense?.status?.().cloudUnavailable===true;}
function transientCloudError(error){
 if(error?.code==='SYNC_NOT_CONVERGED')return false;
 const status=Number(error?.status)||0;
 return status===0||[402,408,425,429].includes(status)||status>=500;
}
async function recordCloudFailure(error,op){
 if(!operationCurrent(op))return;
 const previous=cloudRetryState(),status=Number(error?.status)||0,unavailable=transientCloudError(error);
 const failures=Math.min(20,previous.failures+1);
 const delay=status===402?900000:Math.min(300000,60000*Math.pow(2,Math.min(3,failures-1)));
 store.sync=store.sync||{};
 store.sync.cloudRetry={ownerId:cloudState.user?.id||null,failures,nextRetryAt:Date.now()+delay,status,unavailable,code:error?.code==='SYNC_NOT_CONVERGED'?'SYNC_NOT_CONVERGED':null};
 // Persist only scheduling metadata; credentials and error payloads are excluded.
 try{await saveStore(store);}catch(storageError){console.warn('Retry scheduling persistence',storageError);}
}
function clearCloudFailure(){if(store.sync)delete store.sync.cloudRetry;lastSyncError=false;}
function cloudNoticeHtml(){
 const recovery=store.sync?.storageRecovery;
 const localNotice=recovery?.incomplete?'<section class="card" role="status"><h3 class="section-title">Archivio locale da verificare</h3><p class="subtle">'+(recovery.reason==='indexeddb_unavailable'?'Sto usando la copia locale di riserva. I nuovi salvataggi riusciti restano su questo dispositivo; le copie saranno riunite quando l’archivio principale tornerà disponibile.':'Una copia locale non è leggibile. È mostrato l’archivio disponibile; la copia originale resta conservata e il recupero non è completo.')+'</p></section>':'';
 if(cloudState.user&&cloudRetryState().code==='SYNC_NOT_CONVERGED')return localNotice+'<section class="card"><h3 class="section-title">Sincronizzazione da verificare</h3><p class="subtle">Il cloud risponde, ma alcuni dati sono cambiati durante la sincronizzazione o non sono ancora confermati. I dati restano salvati su questo dispositivo.</p><p class="subtle">Ripeti «Sincronizza tutto» per verificare l’allineamento. I tentativi automatici restano distanziati.</p><div class="actions"><button class="btn secondary" data-action="sync-all">Sincronizza tutto</button></div></section>';
 if(!cloudState.user||!cloudUnavailable())return localNotice;
 const license=globalThis.UniSgiunglaLicense?.status?.()||{};
 const until=license.validUntil?new Date(license.validUntil).toLocaleString('it-IT'):'';
 return localNotice+'<section class="card"><h3 class="section-title">Cloud temporaneamente non disponibile</h3><p class="subtle">Materie e progressi restano salvati su questo dispositivo. Puoi continuare a studiare'+(until?' fino al '+esc(until):' con la verifica di accesso ancora valida')+'. Le modifiche saranno sincronizzate quando il servizio tornerà disponibile.</p><p class="subtle">I tentativi automatici sono distanziati per evitare richieste ripetute. Puoi conservare anche un backup locale.</p><div class="actions"><button class="btn secondary" data-action="backup">Backup completo</button></div></section>';
}
function syncBadgeModel(){
 const dirty=(store.sync?.dirtyCourseIds||[]).length;
 if(!cloudState.user)return {cls:'local',icon:'◇',label:'Solo locale',title:'Cloud non collegato'};
 if(accessState.status==='pending')return {cls:'pending',icon:'⌛',label:'In attesa',title:'Account in attesa di approvazione'};
 if(accessState.status==='suspended')return {cls:'error',icon:'⛔',label:'Sospeso',title:'Account sospeso'};
 if(baseAccessAllowed()&&!featuresAllowed())return {cls:'local',icon:'◇',label:'Account collegato',title:'QuizLab web app non abilitato: banche e progressi restano conservati'};
 if(!navigator.onLine)return {cls:'offline',icon:'◌',label:dirty?('Offline · '+dirty+' in attesa'):'Offline',title:'App offline: i dati restano salvati sul dispositivo'};
 if(syncInFlight)return {cls:'working',icon:'↻',label:'Sincronizzo…',title:'Sincronizzazione cloud in corso'};
 if(cloudRetryState().code==='SYNC_NOT_CONVERGED')return {cls:'error',icon:'!',label:'Sync da verificare',title:'Il cloud risponde; alcuni dati non sono ancora confermati. Ripeti Sincronizza tutto.'};
 if(cloudUnavailable())return {cls:'offline',icon:'◌',label:dirty?('Salvato qui · '+dirty+' in attesa'):'Cloud indisponibile',title:'Studio locale disponibile entro la verifica di accesso. Riprendo automaticamente quando il cloud risponde.'};
 if(lastSyncError)return {cls:'error',icon:'!',label:'Sync da verificare',title:'Ultima sincronizzazione non riuscita: tocca per riprovare'};
 if(dirty)return {cls:'pending',icon:'↑',label:dirty+' da sincronizzare',title:'Modifiche locali in attesa di sincronizzazione automatica'};
 const when=fmtSyncAgo(store.sync?.lastPullAt||store.sync?.lastPushAt);
 return {cls:'ok',icon:'✓',label:'Sincronizzato'+(when?' · '+when:''),title:'Dati allineati con il cloud'};
}
function syncBadgeHtml(){
 const m=syncBadgeModel();
 return '<button class="cloud-badge '+m.cls+'" data-action="cloud" data-sync-badge title="'+esc(m.title)+'"><span class="cloud-badge-icon">'+esc(m.icon)+'</span><span>'+esc(m.label)+'</span></button>';
}

const THEME_KEY='quizlab-lab-theme';
let currentTheme=(()=>{try{return localStorage.getItem(THEME_KEY)==='light'?'light':'dark';}catch(e){return 'dark';}})();
function applyTheme(theme=currentTheme){
 currentTheme=theme==='light'?'light':'dark';
 document.documentElement.dataset.theme=currentTheme;
 try{localStorage.setItem(THEME_KEY,currentTheme);}catch(e){}
 for(const btn of document.querySelectorAll('[data-theme-toggle]')){
  btn.setAttribute('aria-pressed',currentTheme==='light'?'true':'false');
  btn.title=currentTheme==='light'?'Passa al tema scuro':'Passa al tema chiaro';
  const label=btn.querySelector('.theme-toggle-label');if(label)label.textContent=currentTheme==='light'?'Chiaro':'Scuro';
 }
}
function themeToggleHtml(){
 const light=currentTheme==='light';
 return '<button class="theme-toggle" data-action="toggle-theme" data-theme-toggle aria-label="Cambia tema" aria-pressed="'+(light?'true':'false')+'" title="'+(light?'Passa al tema scuro':'Passa al tema chiaro')+'"><span class="theme-toggle-track"><span class="theme-toggle-knob"></span></span><span class="theme-toggle-label">'+(light?'Chiaro':'Scuro')+'</span></button>';
}
applyTheme(currentTheme);

function refreshSyncBadge(){
 const el=document.querySelector('[data-sync-badge]');
 if(!el)return;
 const m=syncBadgeModel();
 el.className='cloud-badge '+m.cls;
 el.title=m.title;
 el.innerHTML='<span class="cloud-badge-icon">'+esc(m.icon)+'</span><span>'+esc(m.label)+'</span>';
}


function emptyCourse(subject=''){return {subject:norm(subject),officialBank:[],aiBank:[],topicMap:null,aiWorkflow:{},attempts:[],exams:[],marked:[],pendingReview:[],historicalWrong:[],fullCampaign:{signature:'all',seenIds:[],resetAt:null},syncMeta:{version:3,performanceResetAt:null,examResetAt:null,reviewResetAt:null,removedQuestionAt:{},markedState:{},pendingState:{},historicalWrongAt:{},fullSeenAt:{}},createdAt:now(),updatedAt:now()};}
function ensureCourseSyncMeta(c){
 const baseAt=c.updatedAt||c.createdAt||'1970-01-01T00:00:00.000Z';
 const raw=c.syncMeta&&typeof c.syncMeta==='object'?c.syncMeta:{};
 c.syncMeta={
  version:3,
  performanceResetAt:raw.performanceResetAt||null,
  examResetAt:raw.examResetAt||null,
  reviewResetAt:raw.reviewResetAt||null,
  removedQuestionAt:raw.removedQuestionAt&&typeof raw.removedQuestionAt==='object'?{...raw.removedQuestionAt}:{},
  markedState:raw.markedState&&typeof raw.markedState==='object'?{...raw.markedState}:{},
  pendingState:raw.pendingState&&typeof raw.pendingState==='object'?{...raw.pendingState}:{},
  historicalWrongAt:raw.historicalWrongAt&&typeof raw.historicalWrongAt==='object'?{...raw.historicalWrongAt}:{},
  fullSeenAt:raw.fullSeenAt&&typeof raw.fullSeenAt==='object'?{...raw.fullSeenAt}:{}
 };
 for(const id of c.marked||[])if(!c.syncMeta.markedState[id])c.syncMeta.markedState[id]={value:true,at:baseAt};
 for(const id of c.pendingReview||[])if(!c.syncMeta.pendingState[id])c.syncMeta.pendingState[id]={value:true,at:baseAt};
 for(const id of c.historicalWrong||[])if(!c.syncMeta.historicalWrongAt[id])c.syncMeta.historicalWrongAt[id]=baseAt;
 for(const id of c.fullCampaign?.seenIds||[])if(!c.syncMeta.fullSeenAt[id])c.syncMeta.fullSeenAt[id]=baseAt;
 return c.syncMeta;
}
function shape(c){
 const x={...emptyCourse(c?.subject||''),...(c||{})};
 for(const k of ['officialBank','aiBank','attempts','exams','marked','pendingReview','historicalWrong'])if(!Array.isArray(x[k]))x[k]=[];
 if(!x.fullCampaign||typeof x.fullCampaign!=='object')x.fullCampaign={signature:'all',seenIds:[],resetAt:null};
 if(!Array.isArray(x.fullCampaign.seenIds))x.fullCampaign.seenIds=[];
 if(!('resetAt' in x.fullCampaign))x.fullCampaign.resetAt=null;
 const resetAt=x.fullCampaign.resetAt;
 const legacyFull=x.attempts.filter(a=>a?.mode==='full'&&(!resetAt||String(a.at)>=String(resetAt))).map(a=>a.questionId);
 x.fullCampaign.seenIds=uniq([...x.fullCampaign.seenIds,...legacyFull]);
 x.marked=uniq(x.marked);x.pendingReview=uniq(x.pendingReview);x.historicalWrong=uniq(x.historicalWrong);
 ensureCourseSyncMeta(x);
 return x;
}
function course(id=route.courseId){return id&&store.courses[id]?shape(store.courses[id]):null;}
function copyCourseProgress(c){return{...c,...structuredClone({attempts:c.attempts||[],exams:c.exams||[],marked:c.marked||[],pendingReview:c.pendingReview||[],historicalWrong:c.historicalWrong||[],fullCampaign:c.fullCampaign,syncMeta:c.syncMeta})};}
function sessionForCheckpoint(){if(!session)return null;const copy=structuredClone(session);delete copy.finishing;for(const answer of Object.values(copy.answers||{}))delete answer.saving;return copy;}
async function saveCourse(id,c,{bankDirty=false}={}){
 if(!featuresAllowed())throw new Error('Accesso allo studio non disponibile: dati conservati');
 assertCourseId(id);
 const op=captureOperation();
 const serial=++localCourseSaveSerial,previousCourse=store.courses[id],previousSync={...store.sync,dirtyCourseIds:[...(store.sync?.dirtyCourseIds||[])],dirtyBankCourseIds:[...(store.sync?.dirtyBankCourseIds||[])]};
 c.updatedAt=now();
 if(bankDirty){assertBankEditable(c);c.bankUpdatedAt=c.updatedAt;}
 store.courses[id]=c;
 store.sync=store.sync||{};
 store.sync.dirtyCourseIds=uniq([...(store.sync.dirtyCourseIds||[]),id]);
 if(bankDirty)store.sync.dirtyBankCourseIds=uniq([...(store.sync.dirtyBankCourseIds||[]),id]);
 store.sync.lastLocalChangeAt=now();
 const changeToken=store.sync.lastLocalChangeAt;
 let saved;
 try{saved=await saveStore(store,{progressCourseId:bankDirty?null:id});}
 catch(error){
  if(operationCurrent(op)&&store.courses[id]===c){
   if(previousCourse)store.courses[id]=previousCourse;else delete store.courses[id];
   if(!previousSync.dirtyCourseIds.includes(id))store.sync.dirtyCourseIds=(store.sync.dirtyCourseIds||[]).filter(value=>value!==id);
   if(bankDirty&&!previousSync.dirtyBankCourseIds.includes(id))store.sync.dirtyBankCourseIds=(store.sync.dirtyBankCourseIds||[]).filter(value=>value!==id);
   if(serial===localCourseSaveSerial&&store.sync.lastLocalChangeAt===changeToken)store.sync.lastLocalChangeAt=previousSync.lastLocalChangeAt;
  }
  throw error;
 }
 if(!operationCurrent(op))return saved;
 if(store.sync?.lastLocalChangeAt===changeToken)store=saved;
 studyHeartbeat().catch(()=>{});
 refreshSyncBadge();
 scheduleAutoSync();
 return saved;
}
function captureOperation(){
 return {generation:workspaceGeneration,workspace:currentWorkspaceKey(),userId:cloudState.user?.id||null,adapter:sync.operationToken?.()};
}
function operationCurrent(op){
 return !!op&&op.generation===workspaceGeneration&&op.workspace===currentWorkspaceKey()&&op.userId===(cloudState.user?.id||null)&&(!sync.isOperationCurrent||sync.isOperationCurrent(op.adapter));
}
function requireOperation(op){
 if(!operationCurrent(op)){const e=new Error('Operazione annullata: account cambiato');e.code='STALE_WORKSPACE';throw e;}
}
function requireStudyOperation(op){
 requireOperation(op);
 if(!featuresAllowed())throw new Error('Accesso allo studio non disponibile: operazione annullata e dati conservati');
}
function assertCourseId(id){
 if(typeof id!=='string'||!id.trim()||id.length>256||['__proto__','prototype','constructor'].includes(id))throw new Error('Identificativo materia non valido');
 return id;
}
function assertBankEditable(c){
 if(c?.managedByAdmin)throw new Error('Questa banca è gestita dall’amministratore. I progressi restano modificabili.');
}
function latestMap(c){const m=new Map();for(const a of c.attempts||[]){const p=m.get(a.questionId);if(!p||String(a.at)>=String(p.at))m.set(a.questionId,a);}return m;}
function metrics(c){
 const b=qbank(c),ids=new Set(b.map(q=>q.id)),latest=[...latestMap(c).values()].filter(a=>ids.has(a.questionId)),ok=latest.filter(a=>a.correct).length;
 const coverage=b.length?latest.length/b.length:0, accuracy=latest.length?ok/latest.length:0, masteryGrade=gradeFromRatio(ok,latest.length);
 const exams=[...(c.exams||[])].sort((a,b)=>String(a.at||'').localeCompare(String(b.at||''))),lastExam=exams.at(-1)||null,last5=exams.slice(-5);
 const avg5=last5.length?last5.reduce((sum,e)=>sum+Number(e.grade||0),0)/last5.length:null,best=exams.length?Math.max(...exams.map(e=>Number(e.grade||0))):null;
 const base=avg5!=null?0.55*avg5+0.45*masteryGrade:masteryGrade,preparation=Math.round(base*(0.75+0.25*coverage)*10)/10;
 const byChapter=new Map(); for(const a of latest){const ch=Number(a.chapter||0);if(!ch)continue;if(!byChapter.has(ch))byChapter.set(ch,{chapter:ch,total:0,correct:0});const r=byChapter.get(ch);r.total++;if(a.correct)r.correct++;}
 const chapterRows=[...byChapter.values()].map(r=>({...r,grade:gradeFromRatio(r.correct,r.total)})).sort((a,b)=>a.chapter-b.chapter);
 const sourceMetrics={}; for(const source of ['official','ai']){const qids=new Set(b.filter(q=>q.source===source).map(q=>q.id)),rows=latest.filter(a=>qids.has(a.questionId)),corr=rows.filter(a=>a.correct).length;sourceMetrics[source]={total:rows.length,grade:rows.length?gradeFromRatio(corr,rows.length):null};}
 const timed=(c.attempts||[]).filter(a=>Number(a.elapsedMs)>0),avgResponseMs=timed.length?timed.reduce((sum,a)=>sum+Number(a.elapsedMs||0),0)/timed.length:0;
 const recent20=recentAccuracy(c,20);
 const previous5=exams.slice(-10,-5),previous5Avg=previous5.length?previous5.reduce((sum,e)=>sum+Number(e.grade||0),0)/previous5.length:null;
 const examTrend=(avg5!=null&&previous5Avg!=null)?Math.round((avg5-previous5Avg)*10)/10:null;
 return {total:b.length,official:c.officialBank.length,ai:c.aiBank.length,attempted:latest.length,correct:ok,coverage,accuracy,pending:c.pendingReview.length,marked:c.marked.length,masteryGrade,preparation,exams,lastExam,avg5,best,chapterRows,sourceMetrics,avgResponseMs,recent20,examTrend};
}
function pct(v){return (v*100).toFixed(1).replace('.',',')+'%';}
function toast(s){clearTimeout(toastTimer);document.querySelector('.toast')?.remove();const d=document.createElement('div');d.className='toast';d.textContent=s;document.body.appendChild(d);toastTimer=setTimeout(()=>d.remove(),2600);}
function download(name,obj){const b=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
function fileName(s){return norm(s).replace(/[\\/:*?"<>|]+/g,'_').replace(/\s+/g,'_')||'QuizLab';}
function initials(name){const p=norm(name).split(' ').filter(Boolean);return (p.slice(0,2).map(x=>x[0]).join('')||'SG').toUpperCase();}
function avatarHtml(size='normal'){const p=store.profile||{},name=p.displayName||'Studente Sgiungla';return p.avatarDataUrl?'<img class="avatar '+size+'" src="'+esc(p.avatarDataUrl)+'" alt="Foto profilo">':'<div class="avatar '+size+' avatar-fallback">'+esc(initials(name))+'</div>';}
function jungleLine(m=null){
 if(!m)return 'La giungla universitaria è sotto controllo.';
 if(m.exams?.length&&m.lastExam?.grade>=27)return 'Hai appena potato un altro pezzo di giungla. 🌿';
 if(m.pending>=10)return 'Ci sono errori tra i cespugli. Andiamo a stanarli. 🐍';
 if(m.coverage>=.75)return 'Ormai nella Sgiungla ti muovi senza machete. 😎';
 if(m.coverage>=.35)return 'Ti stai parcheggiando bene nella Sgiungla. 🅿️🌴';
 return 'Un capitolo alla volta: la giungla non scappa. 🌴';
}
function examBars(m){
 if(!m.exams.length)return '<div class="empty compact">Nessuna simulazione ancora.</div>';
 const xs=m.exams.slice(-8);
 return '<div class="mini-chart">'+xs.map((e,i)=>'<div class="bar-wrap" title="'+esc(String(e.grade))+'/30"><span class="bar-grade">'+(e.lode?'30L':esc(String(e.grade)))+'</span><div class="bar" style="height:'+Math.max(8,(Number(e.grade||0)/30)*100)+'%"></div><small>#'+(m.exams.length-xs.length+i+1)+'</small></div>').join('')+'</div>';
}
function statRing(value,label,sub=''){
 const p=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
 return '<div class="coverage-ring" style="--p:'+p+'"><div><strong>'+p+'%</strong><span>'+esc(label)+'</span>'+(sub?'<small>'+esc(sub)+'</small>':'')+'</div></div>';
}
function coverageRing(m){return statRing(m.coverage*100,'copertura',m.attempted+'/'+m.total);}
function recentAccuracy(c,n=20){const rows=(c.attempts||[]).slice(-n);if(!rows.length)return null;return rows.filter(a=>a.correct).length/rows.length;}
function chapterBadge(x){
 if(x.seenN===0)return '🌱 Da esplorare';
 if(x.level==='strong'&&x.seenN>=Math.min(x.avail,8))return '🏆 Capitolo domato';
 if(x.level==='ok')return '🌿 In controllo';
 if(x.level==='weak')return '🪓 Da potare';
 if(x.level==='critical')return '🐍 Zona insidiosa';
 return '🔎 In analisi';
}


function top(title,sub,back){
 const adminAlert=accessState.isAdmin&&adminPendingCount>0?'<button class="admin-alert" data-action="open-admin" title="Richieste di accesso in attesa">🛡️ '+adminPendingCount+'</button>':'';
 return '<header class="topbar"><div class="topbar-row">'+(back?'<button class="icon-btn" data-action="back">←</button>':'')+'<div class="brand-lockup"><img class="app-mark" src="./icons/quizlab-sgiungla-192.png" alt="QuizLab Sgiungla"><div class="brand">'+esc(title)+'<small>'+esc(sub||'')+'</small></div></div><div class="spacer"></div>'+adminAlert+(globalThis.QUIZLAB_LAB_CONFIG?.studyEnabled!==false&&cloudState.user?'<button class="icon-btn" data-action="study-panel" data-study-tab="goals" title="I miei obiettivi">◎</button><button class="icon-btn" data-action="study-panel" data-study-tab="inbox" aria-label="Centro notifiche">🔔 <span data-study-unread></span></button>':'')+'<span class="theme-toggle-topbar">'+themeToggleHtml()+'</span><button class="profile-chip" data-action="profile">'+avatarHtml('tiny')+'<span>'+(store.profile?.displayName?esc(store.profile.displayName.split(' ')[0]):'Profilo')+'</span></button>'+syncBadgeHtml()+'</div></header>';
}
function bottomNavHtml(){
 const active=route.name;
 const item=(action,label,icon,names)=>'<button data-action="'+action+'" class="'+(names.includes(active)?'active':'')+'"><span>'+icon+'</span><small>'+label+'</small></button>';
 return '<nav class="mobile-bottom-nav">'+item('home','Home','⌂',['home'])+item('profile','Profilo','◉',['profile'])+item('cloud','Cloud','☁',['cloud','access'])+(accessState.isAdmin?item('open-admin','Admin','🛡',['admin']):'')+'</nav>';
}
function page(body,title='QuizLab · Sgiungla',sub='Mobile · offline-first',back=false){app.innerHTML='<div class="app-frame">'+top(title,sub,back)+'<main class="main">'+((route.name==='home'||route.name==='dashboard')&&featuresAllowed()?'<div data-study-summary>'+studySummaryHtml()+'</div>':'')+body+'</main>'+bottomNavHtml()+'</div>';}
function setRoute(name,courseId=route.courseId){if(name==='admin'&&!localAdminMonitorAllowed()){location.assign('./admin.html');return;}if(examTimer){clearInterval(examTimer);examTimer=null;}route={name,courseId};session=null;render();}

function home(){
 const rows=Object.entries(store.courses||{}).map(([id,c])=>[id,shape(c)]).filter(([,c])=>qbank(c).length||c.attempts.length).sort((a,b)=>a[1].subject.localeCompare(b[1].subject));
 const p=store.profile||{};
 const configured=sync.configured(store.settings||{})||sync.configured(DEFAULT_CLOUD_CONFIG||{});
 let html='<div class="stack"><section class="card hero jungle-hero mobile-home-hero"><div class="mobile-brand-row"><img src="./icons/quizlab-sgiungla-192.png" class="mobile-hero-mark" alt="QuizLab Sgiungla"><div><div class="eyebrow">QuizLab · Sgiungla Edition</div><h1>'+(p.displayName?'Ciao, '+esc(p.displayName.split(' ')[0])+' 👋':'Benvenuto nella Sgiungla 🌴')+'</h1><p class="jungle-line">'+esc(p.motto||'La giungla universitaria è sotto controllo.')+'</p></div>'+avatarHtml('large')+'</div><div class="hero-pills"><span>🌿 Multi-materia</span><span>☁️ Cloud</span><span>🧠 AI + spiegazioni</span></div><div class="actions hero-actions"><button class="btn" data-action="import">📥 Importa</button><button class="btn secondary" data-action="backup" '+(rows.length?'':'disabled')+'>💾 Backup</button><button class="btn ghost" data-action="profile">👤 Profilo</button></div></section>';
 if(!cloudState.user){
  if(configured){
   html+='<section class="card"><div class="eyebrow">Account QuizLab</div><h2 class="section-title">Accedi</h2><p class="subtle">Collega il tuo account per ritrovare materie, progressi e profilo sui tuoi dispositivi.</p><label>Email<input id="authEmail" type="email" autocomplete="email"></label><label>Password<input id="authPassword" type="password" autocomplete="current-password" minlength="8"></label><div class="actions"><button class="btn" data-action="sign-in">Accedi</button><button class="btn secondary" data-action="sign-up">Crea account</button></div></section>';
  }else{
   html+='<section class="card"><h2 class="section-title">Cloud non disponibile</h2><p class="subtle">La configurazione cloud della build non è completa.</p></section>';
  }
 }
 if(!rows.length)html+='<section class="card empty"><strong>Nessuna materia.</strong><p>Importa il JSON “banca COMPLETA” esportato dal desktop.</p></section>';
 const courseCard=([id,c])=>{const m=metrics(c);return'<section class="card course-card"><div class="eyebrow">Materia</div><div class="subject-name">'+esc(c.subject||id)+'</div><div class="bank-total"><span>Domande in banca</span><strong>'+m.total+'</strong></div><div class="pill-row"><span class="pill off">'+m.official+' ufficiali</span><span class="pill ai">'+m.ai+' AI</span><span class="pill">'+m.attempted+' affrontate</span></div><div class="stats"><div class="stat"><span>Copertura</span><strong>'+pct(m.coverage)+'</strong></div><div class="stat"><span>Accuratezza</span><strong>'+pct(m.accuracy)+'</strong></div></div><div class="actions"><button class="btn" data-action="open" data-id="'+esc(id)+'">Apri materia →</button><button class="btn secondary" data-action="export" data-id="'+esc(id)+'">Esporta</button></div></section>';};
 html+='<div data-home-courses></div>';
 html+=cloudNoticeHtml()+'<section class="card"><h3 class="section-title">Sincronizzazione</h3><p class="subtle">'+(cloudState.user?'Cloud collegato · sincronizzazione automatica attiva. I progressi restano disponibili anche offline entro la verifica di accesso.':'Puoi continuare a usare QuizLab in locale oppure accedere qui sopra per attivare la sincronizzazione cloud.')+'</p></section></div>';
 page(html);
 globalThis.QuizLabListNavigation.mount(app.querySelector('[data-home-courses]'),{key:currentWorkspaceKey()+':home-courses',rows,renderItem:courseCard,text:([id,c])=>c.subject||id,label:'materie'});
}

function dashboard(){
 const c=course();if(!c)return setRoute('home',null);const m=metrics(c),seen=new Set(c.fullCampaign?.seenIds||[]),remain=Math.max(0,m.total-seen.size),fullPct=m.total?seen.size/m.total:0;
 const byCh=new Map(m.chapterRows.map(r=>[r.chapter,r])),chapters=uniq(qbank(c).map(q=>Number(q.chapter)).filter(Boolean)).sort((a,b)=>a-b);
 const chapterRowsUi=chapters.map(ch=>{const r=byCh.get(ch),avail=qbank(c).filter(q=>Number(q.chapter)===ch).length,seenN=r?.total||0;let grade='—',dot='⚪',note='nessun dato',level='empty';if(seenN){if(seenN<Math.min(5,avail)){note='in analisi';level='analysis';}else{grade=fmtGrade(r.grade);dot=r.grade>=27?'🟢':r.grade>=24?'🟡':r.grade>=18?'🟠':'🔴';level=r.grade>=27?'strong':r.grade>=24?'ok':r.grade>=18?'weak':'critical';note=seenN<(avail<=12?avail:Math.max(5,Math.ceil(avail*0.6)))?'voto provvisorio':'voto consolidato';}}return {ch,avail,seenN,grade,dot,note,level};});
 const managedBadge=c.managedByAdmin?'<span class="pill">🛡️ Gestita dall’amministratore</span>':'';
 const managedNote=c.managedByAdmin?'<p class="subtle">La banca è assegnata e aggiornata dall’amministratore. I tuoi progressi restano personali. Puoi importare altre materie; questa banca non può essere sostituita da un file.</p>':'';
 const deleteCloudControls=c.managedByAdmin?'':'<div><strong>Elimina definitivamente</strong><p class="subtle">Cancella dal cloud banca e progressi della materia e la rimuove da questo dispositivo.</p><button class="btn danger-btn" data-action="delete-cloud-course">🗑️ Elimina definitivamente dal cloud</button></div>';
 const chapterHtml=chapterRowsUi.map(x=>'<div class="result chapter-row '+x.level+'"><div><div class="result-title">Cap. '+x.ch+' · '+x.dot+' '+x.grade+'</div><div class="result-meta">'+x.seenN+'/'+x.avail+' viste · '+x.note+'</div><span class="chapter-badge">'+chapterBadge(x)+'</span></div><button class="btn ghost compact-btn" data-action="train-chapter" data-chapter="'+x.ch+'">Allenati</button></div>').join('');
 const weakList=chapterRowsUi.filter(x=>['weak','critical'].includes(x.level)).sort((a,b)=>(byCh.get(a.ch)?.grade??99)-(byCh.get(b.ch)?.grade??99)).slice(0,5);
 const weakChapters=chapterRowsUi.filter(x=>['weak','critical'].includes(x.level)).length,unseenChapters=chapterRowsUi.filter(x=>x.seenN===0).length;
 const weakHtml=weakList.length?weakList.map(x=>'<button class="focus-chip" data-action="train-chapter" data-chapter="'+x.ch+'"><span>Cap. '+x.ch+'</span><strong>'+x.grade+'</strong></button>').join(''):'<div class="focus-empty">Nessun capitolo critico per ora. La Sgiungla è tranquilla. 🌴</div>';
 page('<div class="stack"><section class="card hero jungle-hero"><div class="dashboard-welcome"><div><div class="eyebrow">'+esc(route.courseId)+'</div><h1>'+esc(c.subject)+'</h1><p class="jungle-line">'+esc(jungleLine(m))+'</p></div>'+avatarHtml('normal')+'</div><div class="hero-kpis"><div class="bank-total hero-total"><span>Domande in banca</span><strong>'+m.total+'</strong></div><div class="ring-pack">'+coverageRing(m)+statRing(m.accuracy*100,'rendimento',m.correct+'/'+m.attempted)+statRing(fullPct*100,'materia completa',seen.size+'/'+m.total)+'</div></div><div class="pill-row"><span class="pill off">'+m.official+' ufficiali</span><span class="pill ai">'+m.ai+' AI</span><span class="pill">'+m.attempted+' affrontate</span>'+managedBadge+'</div>'+managedNote+'<div class="stats"><div class="stat"><span>Preparazione stimata β</span><strong>'+(m.attempted?'≈'+fmtGrade(m.preparation):'—')+'</strong><small>'+(m.attempted?(m.coverage<0.2&&!m.exams.length?'Affidabilità bassa':m.coverage<0.5||m.exams.length<2?'Affidabilità media':'Affidabilità alta'):'nessun dato')+'</small></div><div class="stat"><span>Domande uniche affrontate</span><strong>'+m.attempted+'</strong><small>su '+m.total+' in banca</small></div><div class="stat"><span>Rendimento viste</span><strong>'+(m.attempted?fmtGrade(m.masteryGrade):'—')+'</strong><small>'+(m.attempted?pct(m.accuracy):'nessun dato')+'</small></div><div class="stat"><span>Ultimo esame</span><strong>'+(m.lastExam?(m.lastExam.lode?'30L':fmtGrade(m.lastExam.grade)):'—')+'</strong><small>'+(m.lastExam?fmtDuration(m.lastExam.elapsedMs):'nessuna simulazione')+'</small></div><div class="stat"><span>Media ultime 5</span><strong>'+(m.avg5==null?'—':fmtGrade(m.avg5))+'</strong><small>'+(m.examTrend==null?'simulazioni':(m.examTrend>0?'↗ +':'↘ ')+String(m.examTrend).replace('.',',')+' vs 5 precedenti')+'</small></div><div class="stat"><span>Miglior esame</span><strong>'+(m.best==null?'—':fmtGrade(m.best))+'</strong><small>'+m.exams.length+' simulazioni</small></div><div class="stat"><span>Tentativi totali</span><strong>'+c.attempts.length+'</strong><small>'+(m.avgResponseMs?'tempo medio '+fmtDuration(m.avgResponseMs):'tempo medio —')+'</small></div><div class="stat"><span>Forma recente</span><strong>'+(m.recent20==null?'—':pct(m.recent20))+'</strong><small>ultime 20 risposte</small></div><div class="stat"><span>Percorso materia completa</span><strong>'+seen.size+'/'+m.total+'</strong><small>'+pct(fullPct)+' · '+remain+' rimanenti</small></div></div></section><section class="grid"><button class="card btn secondary" data-action="exam">🎓 Simulazione esame</button><button class="card btn secondary" data-action="training">🧠 Allenamento</button><button class="card btn secondary" data-action="review-page">⭐ Ripasso</button><button class="card btn secondary" data-action="search">🔎 Cerca banca</button></section><section class="card danger-zone"><div class="section-head"><div><div class="eyebrow">Gestione materia</div><h3 class="section-title">Reset separati come desktop</h3></div></div><div class="stack"><div><strong>Azzera performance</strong><p class="subtle">Cancella statistiche, tentativi, voti e simulazioni. Non tocca banca, ripasso o percorso “Materia completa”.</p><button class="btn danger-btn" data-action="reset-performance">♻️ Azzera performance</button></div><div><strong>Ricomincia ciclo</strong><p class="subtle">Azzera solo il percorso “Materia completa”.</p><button class="btn secondary" data-action="reset-cycle">🌱 Ricomincia ciclo</button></div><div><strong>Azzera ripasso</strong><p class="subtle">Cancella storico errori, coda recupero e domande segnate.</p><button class="btn secondary" data-action="reset-review">🧹 Azzera ripasso</button></div></div></section>'+'<section class="card"><div class="section-head"><div><div class="eyebrow">Trend</div><h3 class="section-title">Ultime simulazioni</h3></div><span class="pill">'+m.exams.length+' esami</span></div>'+examBars(m)+'</section><section class="card focus-card"><div class="section-head"><div><div class="eyebrow">Radar Sgiungla</div><h3 class="section-title">Capitoli da rinforzare</h3></div><span class="pill">'+weakChapters+' totali</span></div><div class="focus-list">'+weakHtml+'</div></section>'+(m.ai?'<section class="card"><h3 class="section-title">Performance per tipo</h3><div class="stats"><div class="stat"><span>Ufficiali</span><strong>'+(m.sourceMetrics.official.grade==null?'—':fmtGrade(m.sourceMetrics.official.grade))+'</strong><small>'+m.sourceMetrics.official.total+' uniche</small></div><div class="stat"><span>Rielaborate AI</span><strong>'+(m.sourceMetrics.ai.grade==null?'—':fmtGrade(m.sourceMetrics.ai.grade))+'</strong><small>'+m.sourceMetrics.ai.total+' uniche</small></div></div></section>':'')+'<details class="card collapse-card"><summary><div><div class="eyebrow">Analisi completa</div><h3 class="section-title">Performance per capitolo</h3><div class="pill-row"><span class="pill">'+chapters.length+' capitoli</span>'+(weakChapters?'<span class="pill warn-pill">'+weakChapters+' da rinforzare</span>':'<span class="pill ok-pill">nessuna criticità</span>')+(unseenChapters?'<span class="pill">'+unseenChapters+' non visti</span>':'')+'</div></div><span class="expand-hint">Apri ▾</span></summary><div class="collapse-body">'+chapterHtml+'</div></details><section class="card"><h3 class="section-title">Gestione QuizLab</h3><div class="actions"><button class="btn secondary" data-action="export" data-id="'+esc(route.courseId)+'">Esporta materia</button><button class="btn secondary" data-action="import">Importa / Ripristina</button><button class="btn secondary" data-action="backup">Backup completo</button></div><div class="stack course-delete-box"><div><strong>Rimuovi da questo dispositivo</strong><p class="subtle">Nasconde la materia solo qui. Resta nel cloud e sugli altri dispositivi; una nuova importazione la rende di nuovo visibile.</p><button class="btn secondary" data-action="remove-local-course">📱 Rimuovi da questo dispositivo</button></div>'+deleteCloudControls+'</div></section></div>',c.subject,'Dashboard',true);
}

function training(presetChapter=null){
 const c=course(),all=qbank(c),chs=uniq(all.map(q=>Number(q.chapter)).filter(Boolean)).sort((a,b)=>a-b),first=presetChapter||chs[0],last=chs.at(-1),remain=Math.max(0,all.length-new Set(c.fullCampaign?.seenIds||[]).size),chapterCount=new Map(chs.map(ch=>[ch,all.filter(q=>Number(q.chapter)===ch).length]));
 const sourceOpts='<option value="mixed">Miste</option><option value="official">Solo ufficiali</option><option value="ai">Solo AI</option>';
 page('<div class="stack"><section class="card training-overview"><div><div class="eyebrow">Banca disponibile</div><h2 class="section-title">'+all.length+' domande</h2></div><div class="pill-row"><span class="pill off">'+c.officialBank.length+' ufficiali</span><span class="pill ai">'+c.aiBank.length+' AI</span></div></section><section class="card"><h2 class="section-title">🎓 Simulazione esame</h2><p class="subtle">31 domande · 30 minuti · nessuna correzione durante la prova. Le prime 30 determinano il voto; la 31ª vale solo per la lode.</p><button class="btn" data-action="start-exam" '+(qbank(c).length<31?'disabled':'')+'>Avvia simulazione</button></section><section class="card"><h2 class="section-title">📚 Allenamento per capitolo</h2><div class="row"><label>Capitolo<select id="chapterSelect">'+chs.map(ch=>'<option value="'+ch+'" '+(ch===first?'selected':'')+'>Capitolo '+ch+' · '+chapterCount.get(ch)+' domande</option>').join('')+'</select></label><label>Tipo<select id="chapterSource">'+sourceOpts+'</select></label></div><label>Domande<select id="chapterAmount"><option>10</option><option>20</option><option value="all">Tutte</option></select></label><button class="btn secondary" data-action="start-chapter">Avvia capitolo</button></section><section class="card"><h2 class="section-title">📖 Intervallo di programma</h2><div class="row"><label>Da<select id="rangeFrom">'+chs.map(ch=>'<option value="'+ch+'">'+ch+'</option>').join('')+'</select></label><label>A<select id="rangeTo">'+chs.map(ch=>'<option value="'+ch+'" '+(ch===last?'selected':'')+'>'+ch+'</option>').join('')+'</select></label></div><label>Tipo<select id="rangeSource">'+sourceOpts+'</select></label><label>Domande<select id="rangeAmount"><option>10</option><option>20</option><option>30</option><option>50</option><option value="all">Tutte</option></select></label><button class="btn secondary" data-action="start-range">Avvia intervallo</button></section><section class="card"><h2 class="section-title">🌍 Materia completa</h2><p class="subtle">'+all.length+' domande totali · '+remain+' ancora disponibili nel ciclo corrente.</p><label>Tipo<select id="fullSource">'+sourceOpts+'</select></label><label>Blocco<select id="fullAmount"><option>10</option><option>30</option><option>50</option><option>100</option><option value="all">Tutte le rimanenti</option></select></label><div class="stat"><span>Percorso</span><strong>'+new Set(c.fullCampaign?.seenIds||[]).size+'/'+qbank(c).length+'</strong><small>'+remain+' rimanenti</small></div><div class="actions"><button class="btn" data-action="start-full" '+(remain?'':'disabled')+'>Continua ciclo</button><button class="btn ghost" data-action="reset-cycle">Ricomincia ciclo</button></div></section></div>',c.subject,'Nuovo quiz',true);
}

function filtered(c,source,chapter){return qbank(c).filter(q=>(source==='mixed'||q.source===source)&&(chapter==='all'||Number(q.chapter)===Number(chapter)));}
function filterSource(pool,source){return source==='official'?pool.filter(q=>q.source==='official'):source==='ai'?pool.filter(q=>q.source==='ai'):pool;}
function selectBalanced(pool,count){const out=[],used=new Set(),order=['easy','medium','medium','hard','easy','medium','hard'];let i=0;const clean=shuffle(pool);while(out.length<count&&out.length<clean.length){const wanted=order[i++%order.length],pick=clean.find(q=>!used.has(q.id)&&q.difficulty===wanted)||clean.find(q=>!used.has(q.id));if(!pick)break;used.add(pick.id);out.push(pick);}return shuffle(out);}
function selectTraining(pool,count,source='mixed'){const p=filterSource(pool,source),n=Math.min(count,p.length);if(source!=='mixed')return selectBalanced(p,n);const off=p.filter(q=>q.source==='official'),ai=p.filter(q=>q.source==='ai');if(!off.length||!ai.length)return selectBalanced(p,n);let out=[...selectBalanced(off,Math.min(off.length,Math.ceil(n/2))),...selectBalanced(ai,Math.min(ai.length,Math.floor(n/2)))],ids=new Set(out.map(q=>q.id));if(out.length<n)out=[...out,...selectBalanced(p.filter(q=>!ids.has(q.id)),n-out.length)];return shuffle(out.slice(0,n));}
function amountValue(id,available){const raw=document.getElementById(id)?.value;return raw==='all'?available:Math.min(Number(raw)||0,available);}
async function fullCampaignPool(c,count,source){const all=filterSource(qbank(c),source),seen=new Set(c.fullCampaign?.seenIds||[]),remaining=all.filter(q=>!seen.has(q.id)),latest=new Set(latestMap(c).keys()),never=remaining.filter(q=>!latest.has(q.id)),old=remaining.filter(q=>latest.has(q.id));let out=selectTraining(never,Math.min(count,never.length),source);if(out.length<count){const ids=new Set(out.map(q=>q.id));out=[...out,...selectTraining(old.filter(q=>!ids.has(q.id)),count-out.length,source)];}return out;}
async function resetCycle(){
 const c=course();if(!c)return;
 const ok=confirm('Ricominciare il ciclo “Materia completa”?\n\nVerrà azzerato solo quel percorso. Performance e ripasso resteranno invariati.');
 if(!ok)return;
 const fromTraining=route.name==='training';
 const at=now(),meta=ensureCourseSyncMeta(c);
 c.fullCampaign={signature:'all',seenIds:[],resetAt:at};
 meta.fullSeenAt={};
 await saveCourse(route.courseId,c);
 await cloudSync({silent:true});
 toast('Ciclo materia ricominciato 🌱');
 if(fromTraining)training();else render();
}
async function resetPerformance(){
 const c=course();if(!c)return;
 const ok=confirm('Azzero le performance di questa materia?\n\nVerranno cancellati statistiche, tentativi, voti e simulazioni.\nRipasso, segnate e percorso “Materia completa” resteranno invariati.');
 if(!ok)return;
 const really=confirm('Conferma definitiva: il reset verrà sincronizzato anche nel cloud.');
 if(!really)return;
 const meta=ensureCourseSyncMeta(c);
 meta.performanceResetAt=now();
 c.attempts=[];
 c.exams=[];
 await saveCourse(route.courseId,c);
 await cloudSync({silent:true});
 toast('Performance azzerate ♻️');
 render();
}
async function resetReview(){
 const c=course();if(!c)return;
 const ok=confirm('Azzero il ripasso di questa materia?\n\nVerranno cancellati storico errori, coda recupero e domande segnate.\nPerformance e percorso “Materia completa” resteranno invariati.');
 if(!ok)return;
 const meta=ensureCourseSyncMeta(c);
 meta.reviewResetAt=now();
 meta.markedState={};
 meta.pendingState={};
 meta.historicalWrongAt={};
 c.pendingReview=[];
 c.historicalWrong=[];
 c.marked=[];
 await saveCourse(route.courseId,c);
 await cloudSync({silent:true});
 toast('Ripasso azzerato 🧹');
 render();
}
function startExamTimer(){
 if(examTimer)clearInterval(examTimer);examTimer=null;
 if(!session||session.mode!=='exam'||session.finished)return;
 examTimer=setInterval(()=>{if(!session||session.mode!=='exam'||session.finished){clearInterval(examTimer);examTimer=null;return;}const left=session.durationMs-(Date.now()-session.startedAt);const el=document.getElementById('examTimer');if(el)el.textContent=fmtDuration(left);if(left<=0)finishExam(true).catch(error=>toast(error.message));},1000);
}
function startSession(questions,title,mode='training'){
 if(!featuresAllowed()){licensePage();return;}
 if(!questions.length){toast('Nessuna domanda disponibile');return;}
 clearTimeout(autoSyncTimer);
 session={questions:[...questions],index:0,answers:{},title,mode,reviewPolicy:mode==='review'?'clear-on-correct':null,startedAt:Date.now(),questionShownAt:Date.now(),feedback:null,durationMs:mode==='exam'?30*60*1000:0,finished:false};
 route.name='session';
 startExamTimer();
 render();
}
function current(){return session?.questions?.[session.index]||null;}
function sessionView(){
 const c=course(),q=current();if(!q)return setRoute('dashboard');
 const a=session.answers[q.id]||{},feedback=!!a.confirmed,mark=(c.marked||[]).includes(q.id),isExam=session.mode==='exam',isStudy=session.mode==='study',saving=!!a.saving||!!session.finishing;
 let html='<div class="stack"><section class="card"><div class="toolbar"><span class="pill">'+(session.index+1)+' / '+session.questions.length+'</span><span class="pill '+(q.source==='official'?'off':'ai')+'">'+(q.source==='official'?'Ufficiale':'AI')+'</span><span class="pill">Cap. '+esc(q.chapter)+'</span><span class="pill">'+esc(q.difficulty||'medium')+'</span>'+(q.topic?'<span class="pill">'+esc(q.topic)+'</span>':'')+(isExam?'<span class="pill" id="examTimer">'+fmtDuration(session.durationMs-(Date.now()-session.startedAt))+'</span>':'')+'<button class="btn ghost" data-action="mark">'+(mark?'★ Segnata':'☆ Segna')+'</button></div><div class="progress"><span style="width:'+(((session.index+1)/session.questions.length)*100)+'%"></span></div><div class="question">'+esc(q.text)+'</div>';
 for(const o of q.options||[]){let cl='option';if(a.selected===o.letter)cl+=' selected';if(isStudy&&o.letter===q.correct)cl+=' correct';if(!isExam&&!isStudy&&feedback&&o.letter===q.correct)cl+=' correct';if(!isExam&&!isStudy&&feedback&&a.selected===o.letter&&a.selected!==q.correct)cl+=' wrong';html+='<button class="'+cl+'" data-action="answer" data-letter="'+esc(o.letter)+'" '+((saving||(feedback&&!isExam)||(isExam&&a.confirmed)||isStudy)?'disabled':'')+'><span class="letter">'+esc(o.letter)+'</span><span>'+esc(o.text)+'</span></button>';}
 if(isStudy){html+='<div class="feedback ok"><strong>✅ Risposta corretta evidenziata</strong>'+(q.explanation?'<p>'+esc(q.explanation)+'</p>':'')+(q.reference?'<p class="muted"><strong>Fonte:</strong> '+esc(q.reference)+'</p>':'')+'</div>';}
 else if(!isExam&&feedback){html+='<div class="feedback '+(a.correct?'ok':'bad')+'"><strong>'+(a.correct?'✓ Corretta':'✕ Errata · corretta '+esc(q.correct))+'</strong>'+(q.explanation?'<p>'+esc(q.explanation)+'</p>':'')+(q.reference?'<p class="muted"><strong>Fonte:</strong> '+esc(q.reference)+'</p>':'')+'</div>';}
 if(isExam){const examNextLabel=session.index===session.questions.length-1?(a.selected&&!a.confirmed?'Conferma e consegna':'Consegna'):(a.selected&&!a.confirmed?'Conferma e avanti →':'Avanti →');html+='<div class="actions"><button class="btn ghost" data-action="exam-prev" '+(session.index===0?'disabled':'')+'>← Indietro</button><button class="btn" data-action="exam-next">'+examNextLabel+'</button></div><p class="subtle">'+(a.confirmed?'Risposta registrata · nessuna correzione mostrata.':'Nessuna correzione durante la prova.')+' Le prime 30 determinano il voto; la 31ª vale solo per la lode.</p>';}
 else if(isStudy){html+='<div class="actions"><button class="btn ghost" data-action="study-prev" '+(session.index===0?'disabled':'')+'>← Indietro</button><button class="btn" data-action="study-next">'+(session.index===session.questions.length-1?'Fine':'Prossima →')+'</button></div>';}
 else {html+='<div class="actions">'+(!feedback?'<button class="btn" data-action="confirm" '+(a.selected&&!saving?'':'disabled')+'>'+(saving?'Salvataggio…':'Conferma')+'</button>':'<button class="btn" data-action="next">'+(session.index===session.questions.length-1?'Risultati':'Avanti →')+'</button>')+'</div>';}
 if(saving)html+='<p class="subtle" role="status" aria-live="polite">Salvataggio sul dispositivo…</p>';
 html+='</section></div>';page(html,c.subject,session.title,true);
}

async function confirmAnswer(){
 if(!featuresAllowed()){licensePage();return;}
 if(!session||session.mode==='exam'||session.mode==='study'||session.finished)return;
 const active=session,op=captureOperation(),c=copyCourseProgress(course()),q=current(),a=active.answers[q.id];if(!a?.selected||a.confirmed||a.saving)return;
 const correct=a.selected===q.correct;a.eventId=a.eventId||newEventId();a.at=a.at||now();a.saving=true;
 const elapsedMs=a.elapsedMs??(a.elapsedMs=Date.now()-session.questionShownAt),meta=ensureCourseSyncMeta(c);
 c.attempts.push({eventId:a.eventId,questionId:q.id,chapter:q.chapter,source:q.source,difficulty:q.difficulty,correct,answer:a.selected,at:a.at,elapsedMs,mode:session.mode,...(session.mode==='review'?{reviewPolicy:session.reviewPolicy}:{} )});
 if(session.mode==='full'){
   c.fullCampaign=c.fullCampaign||{signature:'all',seenIds:[],resetAt:null};
   c.fullCampaign.seenIds=uniq([...(c.fullCampaign.seenIds||[]),q.id]);
   meta.fullSeenAt[q.id]=a.at;
 }
 if(!correct){
  c.pendingReview=uniq([...c.pendingReview,q.id]);c.historicalWrong=uniq([...c.historicalWrong,q.id]);
  meta.pendingState[q.id]={value:true,at:a.at};meta.historicalWrongAt[q.id]=a.at;
 }else if(session.mode==='review'&&session.reviewPolicy==='clear-on-correct'){
  c.pendingReview=c.pendingReview.filter(id=>id!==q.id);
  meta.pendingState[q.id]={value:false,at:a.at};
 }
 render();
 try{await saveCourse(route.courseId,c);if(operationCurrent(op)&&session===active){a.confirmed=true;a.correct=correct;}}
 catch(error){if(operationCurrent(op)&&session===active){a.saving=false;render();}throw error;}
 finally{a.saving=false;}
 if(operationCurrent(op)&&session===active)render();
}
function syncAfterLocalStudy(){clearTimeout(autoSyncTimer);autoSyncTimer=null;cloudSync({silent:true}).catch(error=>console.warn('Sincronizzazione studio in attesa',error));}
async function nextQuestion(){if(!session)return;const active=session,op=captureOperation();if(session.index<session.questions.length-1){session.index++;session.questionShownAt=Date.now();render();}else{if(!operationCurrent(op)||session!==active)return;route.name='results';render();syncAfterLocalStudy();}}
function recordExamAnswer(c,q,i,a,at){
 if(a.recorded)return;
 const answered=!!a.selected,correct=answered&&a.selected===q.correct;
 a.confirmed=true;a.recorded=true;a.correct=correct;a.at=a.at||at;
 const elapsedMs=answered?Math.max(0,Number(a.elapsedMs)||0):0,meta=ensureCourseSyncMeta(c);
 c.attempts.push({eventId:a.eventId||(a.eventId=newEventId()),questionId:q.id,chapter:q.chapter,source:q.source,difficulty:q.difficulty,correct,answered,answer:answered?a.selected:null,at:a.at,elapsedMs,mode:'exam',isLode:i===30});
 if(!correct){
  c.pendingReview=uniq([...c.pendingReview,q.id]);c.historicalWrong=uniq([...c.historicalWrong,q.id]);
  meta.pendingState[q.id]={value:true,at:a.at};meta.historicalWrongAt[q.id]=a.at;
 }
}
async function confirmExamAnswer(){
 if(!featuresAllowed()){licensePage();return;}
 if(!session||session.mode!=='exam'||session.finished)return;
 const active=session,op=captureOperation(),c=copyCourseProgress(course()),q=current(),a=active.answers[q.id];if(!a?.selected||a.confirmed||a.saving||active.finishing)return;
 a.eventId=a.eventId||newEventId();a.at=a.at||now();a.elapsedMs=a.elapsedMs??Math.max(0,Date.now()-active.questionShownAt);a.saving=true;
 const staged={...a};recordExamAnswer(c,q,active.index,staged,a.at);render();
 try{await saveCourse(route.courseId,c);if(operationCurrent(op)&&session===active)Object.assign(a,staged,{saving:false});}
 catch(error){if(operationCurrent(op)&&session===active){a.saving=false;render();}throw error;}
 finally{a.saving=false;}
}
async function finishExam(timeout=false){
 if(!featuresAllowed()){licensePage();return;}
 if(!session||session.mode!=='exam'||session.finished||session.finishing)return;
 const activeSession=session,op=captureOperation(),courseId=route.courseId;
 activeSession.finishing=true;if(examTimer){clearInterval(examTimer);examTimer=null;}
 const c=copyCourseProgress(course(courseId));let correct=0,lodeCorrect=false;const wrong=[],at=now(),stagedAnswers={};
 activeSession.questions.forEach((q,i)=>{
  const original=activeSession.answers[q.id]||(activeSession.answers[q.id]={});
  if(!original.recorded){original.eventId=original.eventId||newEventId();original.at=original.at||at;}
  const a=stagedAnswers[q.id]={...original};
  if(i===activeSession.index&&a.selected&&!a.recorded)a.elapsedMs=a.elapsedMs??Math.max(0,Date.now()-activeSession.questionShownAt);
  recordExamAnswer(c,q,i,a,at);
  const ok=a.correct,isLode=i===30;
  if(!isLode&&ok)correct++;if(isLode)lodeCorrect=ok;if(!ok)wrong.push(q.id);
 });
 const grade=correct,lode=correct===30&&lodeCorrect,elapsedMs=Date.now()-activeSession.startedAt;
 activeSession.examEventId=activeSession.examEventId||newEventId();
 c.exams.push({eventId:activeSession.examEventId,at,grade,lode,correct30:correct,lodeCorrect,elapsedMs,timeout,wrongIds:wrong,questionIds:activeSession.questions.map(q=>q.id),answeredCount:Object.values(activeSession.answers).filter(a=>a?.selected).length});
 render();
 try{await saveCourse(courseId,c);}
 catch(error){
  if(operationCurrent(op)&&session===activeSession){activeSession.finishing=false;if(activeSession.durationMs-(Date.now()-activeSession.startedAt)>0)startExamTimer();render();}
  throw error;
 }
 finally{activeSession.finishing=false;}
 if(!operationCurrent(op)||session!==activeSession)return;
 for(const [id,answer]of Object.entries(stagedAnswers))Object.assign(activeSession.answers[id],answer,{saving:false});
 activeSession.finished=true;activeSession.examResult={grade,lode,correct,elapsedMs,wrong};
 route.name='results';render();syncAfterLocalStudy();
}
function results(){if(session?.mode==='exam'){const r=session.examResult;if(!r)return;page('<section class="card hero"><div class="eyebrow">🎓 Esito simulazione</div><h1>'+(r.lode?'30 e lode':r.grade+'/30')+'</h1><p>'+r.correct+'/30 corrette · '+fmtDuration(r.elapsedMs)+'</p><div class="actions"><button class="btn" data-action="dashboard">Dashboard</button><button class="btn secondary" data-action="retry-wrong">Ripassa gli errori</button></div></section>',course().subject,'Risultati',true);return;}const done=Object.entries(session.answers).filter(([,a])=>a.confirmed),ok=done.filter(([,a])=>a.correct).length,total=done.length;page('<section class="card hero"><div class="eyebrow">Sessione completata</div><h1>'+fmtGrade(gradeFromRatio(ok,total))+'</h1><p>'+ok+' / '+total+' · '+pct(total?ok/total:0)+' corrette</p><div class="actions"><button class="btn" data-action="dashboard">Torna alla materia</button><button class="btn secondary" data-action="retry-wrong">Ripassa gli errori</button></div></section>',course().subject,'Risultati',true);}

function review(kind){const c=course(),by=new Map(qbank(c).map(q=>[q.id,q]));let ids=[],title='Ripasso';if(kind==='marked'){ids=c.marked;title='Segnate da me';}else if(kind==='historical'){ids=c.historicalWrong;title='Tutti gli errori storici';}else {ids=c.pendingReview;title='Errori da recuperare';}const qs=uniq(ids).map(id=>by.get(id)).filter(Boolean);startSession(qs,title,'review');if(session)session.reviewPolicy=kind==='marked'||kind==='historical'?'keep-history':'clear-on-correct';}
function reviewPage(){const c=course();page('<div class="stack"><section class="card hero"><div class="eyebrow">Ripasso mirato</div><h1>Errori e domande segnate</h1></section><section class="grid"><div class="card"><h3>❌ Tutti gli errori storici</h3><p class="subtle">'+c.historicalWrong.length+' domande sbagliate almeno una volta. Questo elenco non si riduce quando poi rispondi bene.</p><button class="btn" data-action="review" data-kind="historical" '+(c.historicalWrong.length?'':'disabled')+'>Rivedi tutti</button></div><div class="card"><h3>🧹 Errori da recuperare</h3><p class="subtle">'+c.pendingReview.length+' domande ancora da smaltire. Una risposta corretta in ripasso le toglie dalla coda.</p><button class="btn" data-action="review" data-kind="pending" '+(c.pendingReview.length?'':'disabled')+'>Smaltisci errori</button></div><div class="card"><h3>⭐ Segnate da me</h3><p class="subtle">'+c.marked.length+' domande salvate manualmente.</p><button class="btn secondary" data-action="review" data-kind="marked" '+(c.marked.length?'':'disabled')+'>Ripassa segnate</button></div></section></div>',c.subject,'Ripasso',true);}

function profilePage(){
 const p=store.profile||{};
 const profileCloudText=cloudState.user&&accessState.status==='active'
  ?'Profilo collegato al tuo account cloud. Nome e frase vengono sincronizzati tra i dispositivi; la foto verrà sincronizzata nel prossimo step.'
  :'Profilo locale del dispositivo.';
 const profileSyncStatus=cloudState.user
  ?(accessState.status==='active'?(featuresAllowed()?'Cloud collegato · sincronizzazione attiva':'Account collegato · QuizLab web app non abilitato'):accessState.status==='pending'?'In attesa di approvazione':'Account sospeso')
  :'Solo locale';
 page('<div class="stack"><section class="card hero jungle-hero"><div class="profile-hero">'+avatarHtml('large')+'<div><div class="eyebrow">Identità Sgiungla</div><h1>'+(p.displayName?esc(p.displayName):'Il tuo profilo')+'</h1><p class="subtle">'+esc(profileCloudText)+'</p></div></div></section><section class="card"><h2 class="section-title">Profilo</h2><label>Nome<input id="profileName" maxlength="60" placeholder="Come vuoi essere chiamato" value="'+esc(p.displayName||'')+'"></label><label>Frase Sgiungla<input id="profileMotto" maxlength="120" value="'+esc(p.motto||'La giungla universitaria è sotto controllo.')+'"></label><div class="actions"><button class="btn secondary" data-action="avatar-pick">📷 Cambia foto</button><button class="btn" data-action="save-profile">Salva profilo</button></div><input id="avatarPicker" type="file" accept="image/*" hidden></section><section class="card appearance-card"><div class="eyebrow">Aspetto</div><h3 class="section-title">Tema dell’app</h3><p class="subtle">La scelta resta salvata su questo dispositivo.</p><div class="appearance-row"><div><strong>Tema '+(currentTheme==='light'?'chiaro':'scuro')+'</strong><small>Puoi cambiarlo in qualsiasi momento.</small></div>'+themeToggleHtml()+'</div></section><section class="card"><h3 class="section-title">Sincronizzazione</h3><div class="sync-panel"><div><span>Account</span><strong>'+esc(cloudState.user?.email||'—')+'</strong></div><div><span>Dispositivo</span><strong>'+esc(store.sync?.clientId||'—')+'</strong></div><div><span>Stato</span><strong>'+esc(profileSyncStatus)+'</strong></div></div><p class="subtle">Banca e progressi restano separati per account. Un backup desktop importa i dati di studio senza sostituire account, profilo o configurazione cloud.</p></section></div>','Profilo','Sgiungla ID',true);
 setTimeout(()=>{document.getElementById('avatarPicker')?.addEventListener('change',handleAvatar);},0);
}
async function handleAvatar(e){
 const op=captureOperation();
 const f=e.target.files?.[0];if(!f)return;if(f.size>2.5*1024*1024){toast('Foto troppo grande: massimo 2,5 MB');return;}
 const reader=new FileReader();
 reader.onload=async()=>{
  if(!operationCurrent(op)||!baseAccessAllowed())return;
  store.profile.avatarDataUrl=String(reader.result||'');
  store.profile.updatedAt=now();
  store.sync.profileDirty=true;
  store.sync.lastLocalChangeAt=now();
  await saveStore(store);
  if(!operationCurrent(op))return;
  if(cloudState.user&&accessState.status==='active'){
   try{
    const path=await sync.uploadAvatar(f);
    requireOperation(op);
    store.profile.avatarPath=path;
    await sync.upsertProfile(store.profile);
    requireOperation(op);
    store.sync.profileDirty=false;
    store.sync.lastPushAt=now();
    await saveStore(store);
    requireOperation(op);
    toast('Foto profilo sincronizzata ☁️');
   }catch(err){if(!operationCurrent(op))return;console.warn('Avatar upload',err);toast('Foto salvata in locale · sync avatar non riuscita');}
  }else{
   toast('Foto profilo aggiornata');
  }
  profilePage();
 };
 reader.readAsDataURL(f);
}

async function saveProfile({pushOnly=false}={}){
 if(!baseAccessAllowed()){licensePage();return;}
 const op=captureOperation();
 try{
  if(!pushOnly){
   store.profile.displayName=norm(document.getElementById('profileName')?.value).slice(0,60);
   store.profile.motto=norm(document.getElementById('profileMotto')?.value).slice(0,120)||'La giungla universitaria è sotto controllo.';
   store.profile.updatedAt=now();store.sync.profileDirty=true;store.sync.lastLocalChangeAt=now();
   await saveStore(store);requireOperation(op);
  }
  const profile=JSON.parse(JSON.stringify(store.profile||{}));
  if(cloudState.user){
   await sync.upsertProfile(profile);requireOperation(op);
   if(store.profile?.updatedAt===profile.updatedAt)store.sync.profileDirty=false;
   store.sync.lastPushAt=now();await saveStore(store);requireOperation(op);
  }
  toast(pushOnly?'Profilo sincronizzato ☁️':'Profilo salvato 🌴');
  if(pushOnly)cloudPage();else profilePage();
 }catch(error){
  if(!operationCurrent(op))return;
  console.warn('Profile save',error);toast('Profilo salvato in locale · sync da verificare');
 }
}

async function selectWorkspaceForSession(authSession,{explicit=false}={}){
 const user=authSession?.user||null;
 if(cloudState.user?.id!==user?.id)navigator.serviceWorker?.controller?.postMessage({type:'QUIZLAB_PUSH_POLICY',userId:null});
 if(globalThis.QuizLabStudyUI?.active()?.accountId!==user?.id)globalThis.QuizLabStudyUI?.close();
 studyTelemetryClean=null;studyOverview=null;studyOverviewUser=null;
 const generation=++workspaceGeneration;
 syncRunId++;syncInFlight=false;syncQueuedManual=false;clearTimeout(autoSyncTimer);
 cloudState={status:'cloud-ready',user};
 accessState={status:user?'unverified':'active',isAdmin:false,legacy:false};
 adminData={users:[],storage:null,courses:[],retiredCourses:[],plans:[],loaded:false};adminUsers=null;adminPageRequestId++;adminPendingCount=0;
 if(examTimer){clearInterval(examTimer);examTimer=null;}
 session=null;
 if(!user){
  const next=await selectWorkspace(null);
  if(generation!==workspaceGeneration)return;
  store=next;
  await applyDefaultCloudConfig();
  if(generation!==workspaceGeneration)return;
  cloudState={status:'cloud-ready',user:null};
  accessState={status:'active',isAdmin:false,legacy:true};
  guestDataPending=false;
  route={name:'home',courseId:null};
  globalThis.__quizlabSessionReset=Date.now();
  session=null;
  return;
 }
 const info=await workspaceMigrationInfo(user.id);
 if(generation!==workspaceGeneration)return;
 guestDataPending=!!info.needsDecision;
 // Safe default: login always opens only this account's workspace.
 // Local guest data stays separate until the user explicitly imports it from the UI.
 const next=await selectWorkspace(user.id,{importGuest:false,markGuestHandled:false});
 if(generation!==workspaceGeneration)return;
 store=next;
 await applyDefaultCloudConfig();
 if(generation!==workspaceGeneration)return;
 store.sync.ownerId=user.id;
 await saveStore(store);
 if(generation!==workspaceGeneration)return;
 route={name:'home',courseId:null};
 session=null;
}

async function applyDefaultCloudConfig(){
 const d=DEFAULT_CLOUD_CONFIG||{};
 if(!store.settings)store.settings={};
 let changed=false;
 // LAB config is authoritative: never restore a production URL from a backup.
 if(d.supabaseUrl&&store.settings.supabaseUrl!==d.supabaseUrl){store.settings.supabaseUrl=d.supabaseUrl;changed=true;}
 if(d.supabasePublishableKey&&store.settings.supabasePublishableKey!==d.supabasePublishableKey){store.settings.supabasePublishableKey=d.supabasePublishableKey;changed=true;}
 if(changed)await saveStore(store);
}
async function hydrateCloudProfile(){
 if(!cloudState.user)return;
 if(cloudRetryBlocked())return;
 const op=captureOperation();
 try{
  const p=await sync.pullProfile();
  requireOperation(op);
  if(!p)return;
  store.profile.displayName=p.display_name||store.profile.displayName||'';
  store.profile.motto=p.motto||store.profile.motto||'La giungla universitaria è sotto controllo.';
  store.profile.avatarPath=p.avatar_url||store.profile.avatarPath||'';
  if(p.avatar_signed_url)store.profile.avatarDataUrl=p.avatar_signed_url;
  store.profile.updatedAt=p.updated_at||store.profile.updatedAt;
  store.sync.profileDirty=false;
  await saveStore(store);
  requireOperation(op);
 }catch(e){console.warn('Profile pull',e);}
}
function applyConfirmedPushProgress(items=[]){
 for(const item of items||[]){
  if(!item?.courseId||!item?.progress||!store.courses[item.courseId])continue;
  const local=shape(store.courses[item.courseId]);
  // item.progress is already the exact state accepted by the atomic cloud write.
  // In a conflict it already contains the resolved merge. Re-merging it with
  // the pre-push local snapshot can resurrect state intentionally cleared by a
  // reset (marked/review/history), so the confirmed server state must win here.
  const confirmed=sync.normalizeProgress(item.progress);
  const bankCourse=item.bank?sync.applyBankToCourse(local,item.bank,item.bankRevision,item.bankUpdatedAt):local;
  if(item.bank)bankCourse.cloudBankBase=item.bank;
  if(item.managedByAdmin!==undefined)bankCourse.managedByAdmin=!!item.managedByAdmin;
  store.courses[item.courseId]=shape({
   ...bankCourse,
   attempts:confirmed.attempts,
   exams:confirmed.exams,
   marked:confirmed.marked,
   pendingReview:confirmed.pendingReview,
   historicalWrong:confirmed.historicalWrong,
   fullCampaign:confirmed.fullCampaign,
   syncMeta:confirmed.syncMeta,
   cloudRevision:Number(item.revision||local.cloudRevision||0),
   updatedAt:confirmed.updatedAt||local.updatedAt
  });
 }
}

function mergeQuestionRows(localRows=[],remoteRows=[],preferRemote=true){
 const out=new Map();
 const first=preferRemote?localRows:remoteRows;
 const second=preferRemote?remoteRows:localRows;
 for(const q of first||[])if(q?.id)out.set(q.id,q);
 for(const q of second||[])if(q?.id)out.set(q.id,{...(out.get(q.id)||{}),...q});
 return [...out.values()];
}
function mergeRemoteCourses(rows=[],{mergeBanks=false,mergeProgressState=false}={}){
 const hidden=new Set(store.sync?.hiddenCourseIds||[]);
 for(const remote of rows){
  if(!remote?.courseId)continue;
  assertCourseId(remote.courseId);
  if(hidden.has(remote.courseId))continue;
  const local=shape(store.courses[remote.courseId]||emptyCourse(remote.subject||remote.courseId));
  const rawBank=remote.bank||{},remoteProgress=remote.progress||{};
  const bank={...rawBank,...normalizeBanks(rawBank)};
  const wasBankDirty=(store.sync?.dirtyBankCourseIds||[]).includes(remote.courseId);
  const shouldMerge=(mergeBanks||wasBankDirty)&&!remote.managedByAdmin;
  const mergedRaw=shouldMerge?sync.mergeBanks(sync.bankPayload(local),bank):bank;
  // Equal-time conflict resolution can select a legacy question without source
  // or other defaults. Keep the merged content and metadata, then validate its
  // representation consistently with the saved remote baseline.
  const mergedBank={...mergedRaw,...normalizeBanks(mergedRaw)};
  const bankCourse=sync.applyBankToCourse(local,mergedBank,remote.bankRevision,remote.bankUpdatedAt||bank.updatedAt||remote.updatedAt);
  bankCourse.cloudBankBase=bank;
  bankCourse.managedByAdmin=!!remote.managedByAdmin;
  if(bankCourse.managedByAdmin){
   // Managed content is the administrator's snapshot; only personal progress is writable.
   store.sync.ackBankChanges={...(store.sync.ackBankChanges||{}),[remote.courseId]:sync.bankHash(sync.bankPayload(bankCourse))};
   store.sync.dirtyBankCourseIds=(store.sync?.dirtyBankCourseIds||[]).filter(id=>id!==remote.courseId);
  }
  if(shouldMerge&&sync.bankHash(sync.bankPayload(bankCourse))!==sync.bankHash(bank)){
   store.sync.dirtyBankCourseIds=uniq([...(store.sync?.dirtyBankCourseIds||[]),remote.courseId]);
   store.sync.dirtyCourseIds=uniq([...(store.sync?.dirtyCourseIds||[]),remote.courseId]);
  }
  // A manual full refresh is allowed while local progress is still dirty.
  // In that case never replace local progress with the older cloud snapshot:
  // merge event/state metadata first, then the normal push can publish the union.
  const progress=mergeProgressState
    ? sync.mergeProgress(sync.progressPayload(local),remoteProgress)
    : remoteProgress;
  store.courses[remote.courseId]=shape({
    ...bankCourse,
    subject:remote.subject||local.subject,
    attempts:Array.isArray(progress.attempts)?progress.attempts:local.attempts,
    exams:Array.isArray(progress.exams)?progress.exams:local.exams,
    marked:Array.isArray(progress.marked)?progress.marked:local.marked,
    pendingReview:Array.isArray(progress.pendingReview)?progress.pendingReview:local.pendingReview,
    historicalWrong:Array.isArray(progress.historicalWrong)?progress.historicalWrong:local.historicalWrong,
    fullCampaign:progress.fullCampaign||local.fullCampaign,
    syncMeta:progress.syncMeta||local.syncMeta,
    cloudRevision:Number(remote.revision||local.cloudRevision||0),
    createdAt:progress.createdAt||bank.createdAt||local.createdAt,
    updatedAt:progress.updatedAt||bank.updatedAt||remote.updatedAt||local.updatedAt
  });
 }
}
async function refreshAccessGate({renderBlocked=true,force=false}={}){
 if(!cloudState.user)return {status:'signed-out',isAdmin:false};
 if(!force&&cloudRetryBlocked()){
  if(baseAccessAllowed())accessState={...accessState,status:'active',legacy:false};
  return accessState;
 }
 const op=captureOperation();
 try{
  const state=await sync.accessState();
  requireOperation(op);accessState=state;
  if(accessState.status!=='active'){
   clearTimeout(autoSyncTimer);
   if(examTimer){clearInterval(examTimer);examTimer=null;}
   session=null;
   route.name='access';
   if(renderBlocked)accessPage();
  }
  return accessState;
 }catch(e){
  console.warn('Access gate',e);
  if(!operationCurrent(op))return accessState;
  if([401,403].includes(Number(e?.status)))await globalThis.UniSgiunglaLicense?.refresh();
  if(!operationCurrent(op))return accessState;
  await recordCloudFailure(e,op);
  if(operationCurrent(op)&&baseAccessAllowed())accessState={...accessState,status:'active',legacy:false};
  return accessState;
 }
}
async function cloudSync({silent=true,ignoreBackoff=false,throwOnFailure=false}={}){
 if(ignoreBackoff)globalThis.localStorage?.removeItem?.(sync.transportRetryKey);
 if(!featuresAllowed())return false;
 if(!cloudState.user||!navigator.onLine)return false;
 if(silent&&!ignoreBackoff&&cloudRetryBlocked()){refreshSyncBadge();return false;}
 // A manual click must never be silently discarded just because an automatic
 // sync is already running. Queue one follow-up pass so the UI is hydrated
 // with the newest cloud state as soon as the current pass finishes.
 if(syncInFlight){
  if(!silent){
   syncQueuedManual=true;
   toast('Sincronizzazione già in corso · aggiorno appena termina ☁️');
  }
  return false;
 }
 if(accessState.status!=='active'){route.name='access';render();return false;}
 const op=captureOperation(),runId=++syncRunId;
 const pushedCourses=JSON.parse(JSON.stringify(store.courses||{}));
 const changeToken=store.sync?.lastLocalChangeAt||null;
 const uiBefore=Object.entries(store.courses||{}).map(([id,raw])=>{
  const x=shape(raw);
  return [id,x.subject,x.officialBank.length,x.aiBank.length,x.updatedAt||''].join('::');
 }).sort().join('|');
 const dirtyAtStart=[...(store.sync?.dirtyCourseIds||[])];
 const bankDirtyAtStart=[...(store.sync?.dirtyBankCourseIds||[])];
 let changedDuringSync=false,completed=false;
 syncInFlight=true;lastSyncError=false;refreshSyncBadge();
 try{
  const result=await sync.syncNow({
   dirtyCourseIds:[...(store.sync?.dirtyCourseIds||[])],
   dirtyBankCourseIds:[...(store.sync?.dirtyBankCourseIds||[])].filter(id=>!pushedCourses[id]?.managedByAdmin),
   courses:pushedCourses,
   clientId:store.sync?.clientId
  });
  requireOperation(op);
  const blockedIds=[...(result.blockedCourseIds||[])];
  if(blockedIds.length){
   for(const id of blockedIds)delete store.courses[id];
   store.sync.dirtyCourseIds=(store.sync?.dirtyCourseIds||[]).filter(id=>!blockedIds.includes(id));
   store.sync.dirtyBankCourseIds=(store.sync?.dirtyBankCourseIds||[]).filter(id=>!blockedIds.includes(id));
   store.sync.hiddenCourseIds=uniq([...(store.sync?.hiddenCourseIds||[]),...blockedIds]);
   if(route.courseId&&blockedIds.includes(route.courseId)){route={name:'home',courseId:null};session=null;}
  }
  // A sync may have started with an older snapshot while the user keeps studying.
  // Detect that BEFORE applying the server-confirmed push state. Otherwise an
  // in-flight sync can overwrite a newer local exam/attempt with its older
  // snapshot (for example: new 6/30 briefly shown, then old 23/30 restored).
  changedDuringSync=(store.sync?.lastLocalChangeAt||null)!==changeToken;
  if(!changedDuringSync){
   applyConfirmedPushProgress(result.push?.items||[]);
   mergeRemoteCourses(result.pull?.courses||[]);
   const confirmedIds=(result.push?.items||[]).map(item=>item.courseId);
   store.sync.ackCourseChanges={...(store.sync.ackCourseChanges||{})};
   store.sync.ackBankChanges={...(store.sync.ackBankChanges||{})};
   for(const id of confirmedIds){
    if(pushedCourses[id])store.sync.ackCourseChanges[id]=store.courses[id]?.updatedAt||pushedCourses[id].updatedAt;
    if(bankDirtyAtStart.includes(id)&&pushedCourses[id])store.sync.ackBankChanges[id]=sync.bankHash(sync.bankPayload(pushedCourses[id]));
   }
   store.sync.dirtyCourseIds=(store.sync?.dirtyCourseIds||[]).filter(id=>!dirtyAtStart.includes(id)||!confirmedIds.includes(id));
   store.sync.dirtyBankCourseIds=(store.sync?.dirtyBankCourseIds||[]).filter(id=>!bankDirtyAtStart.includes(id)||!confirmedIds.includes(id)||sync.bankHash(sync.bankPayload(store.courses[id]))!==sync.bankHash(sync.bankPayload(pushedCourses[id])));
  }
  store.sync.lastPushAt=now();
  store.sync.lastPullAt=now();
  store.sync.mode='cloud-online';
  clearCloudFailure();
  const saved=await saveStore(store);
  requireOperation(op);
  if(!changedDuringSync&&store.sync?.lastLocalChangeAt===changeToken)store=saved;
  completed=true;
  const uiAfter=Object.entries(store.courses||{}).map(([id,raw])=>{
   const x=shape(raw);
   return [id,x.subject,x.officialBank.length,x.aiBank.length,x.updatedAt||''].join('::');
  }).sort().join('|');
  const cloudChangedUi=uiAfter!==uiBefore;
  if(!silent){toast('Sincronizzazione completa ☁️');render();}
  else if(cloudChangedUi&&(route.name==='home'||route.name==='dashboard'))render();
  else refreshSyncBadge();
  return true;
 }catch(e){
  if(e?.code==='STALE_WORKSPACE'||!operationCurrent(op))return false;
  lastSyncError=true;
  console.warn('Cloud sync',e);
  await recordCloudFailure(e,op);
  const checked=transientCloudError(e)?accessState:await refreshAccessGate({renderBlocked:false,force:true});
  if(!operationCurrent(op))return false;
  if(checked?.status&&checked.status!=='active'){
   lastSyncError=false;
   route.name='access';
   render();
   if(throwOnFailure)throw e;
   return false;
  }
  // The full manual recovery owns its single notification. Preserve the HTTP
  // failure already recorded here instead of replacing it with a generic error.
  if(throwOnFailure)throw e;
  if(!silent)alert(transientCloudError(e)?'Cloud temporaneamente non disponibile. I dati sono salvati su questo dispositivo e puoi continuare a studiare entro la verifica di accesso. La sincronizzazione riprenderà quando il servizio torna disponibile.':'Sincronizzazione non riuscita:\n'+(e?.message||e));
  if(route.name==='home'||route.name==='cloud')render();
  return false;
 }finally{
  if(runId===syncRunId&&operationCurrent(op)){
   syncInFlight=false;refreshSyncBadge();
   studyHeartbeat().catch(()=>{});
   const runQueuedManual=syncQueuedManual;syncQueuedManual=false;
   if(completed&&(changedDuringSync||runQueuedManual)&&cloudState.user&&navigator.onLine&&!cloudRetryBlocked()){
    setTimeout(()=>{if(operationCurrent(op))cloudSync({silent:!runQueuedManual});},120);
   }
  }
 }
}
async function forceCloudPullAll(){
 if(!featuresAllowed()){licensePage();return false;}
 if(!cloudState.user){toast('Collega prima il tuo account cloud');return false;}
 if(!navigator.onLine){toast('Sei offline: impossibile leggere il cloud');return false;}
 if(syncInFlight){
  syncQueuedManual=true;
  toast('Sincronizzazione già in corso · aggiorno dal cloud appena termina ☁️');
  return false;
 }
 const op=captureOperation(),runId=++syncRunId;
 let convergenceFailureHandled=false;
 syncInFlight=true;lastSyncError=false;refreshSyncBadge();
 try{
  store.sync=store.sync||{};
  const pull=await sync.pullChanges({clientId:store.sync?.clientId,courses:store.courses});
  requireOperation(op);
  const rows=Array.isArray(pull?.courses)?pull.courses:[];
  store.sync.hiddenCourseIds=[];
  const remoteIds=new Set(rows.map(x=>x?.courseId).filter(Boolean));

  // Manual "Sincronizza tutto" is a recovery/full-refresh operation:
  // hydrate cloud banks first and merge question banks so a stale/empty local
  // copy can never hide a newer cloud bank. Local-only questions are preserved.
  mergeRemoteCourses(rows,{mergeBanks:true,mergeProgressState:true});

  // A course that has just been hydrated from the cloud must not remain marked
  // as a stale local bank waiting to overwrite that same cloud bank.
  // Preserve dirty banks after the reset-aware merge. A local-only question
  // must be acknowledged by a bank write before declaring convergence.
  store.sync.lastPullAt=now();
  store.sync.mode='cloud-online';
  await saveStore(store);
  requireOperation(op);

  // Manual sync is a convergence operation: after the pull-first merge,
  // publish the union for every visible course, not only items already marked dirty.
  // This repairs a stale device and makes the cloud the same superset seen locally.
  const convergeIds=Object.entries(store.courses||{})
    .filter(([,raw])=>raw&&!raw.archived&&!raw.cloudBlocked)
    .map(([id])=>id);
  store.sync.dirtyCourseIds=uniq([...(store.sync.dirtyCourseIds||[]),...convergeIds]);
  await saveStore(store);
  requireOperation(op);

  syncInFlight=false;
  refreshSyncBadge();
  if(convergeIds.length){
    // This pass belongs to the user's explicit recovery operation, even though
    // its notification is silent. Bypass only the retry timer, never access gates.
    let ok;
    try{ok=await cloudSync({silent:true,ignoreBackoff:true,throwOnFailure:true});}
    catch(e){convergenceFailureHandled=true;throw e;}
    requireOperation(op);
    if(!ok)throw new Error('Il push di convergenza non è stato confermato');
  }

  // Final authoritative read: prove that this client can read back what was
  // just converged, then merge once more before declaring success.
  const verify=await sync.pullChanges({clientId:store.sync?.clientId,courses:store.courses});
  requireOperation(op);
  const verifiedRows=Array.isArray(verify?.courses)?verify.courses:[];
  const verifiedById=new Map(verifiedRows.map(row=>[row.courseId,row]));
  for(const id of convergeIds){
   const local=store.courses[id],remote=verifiedById.get(id);
   if(!local&&(store.sync?.hiddenCourseIds||[]).includes(id))continue;
   if(!remote||!local)throw Object.assign(new Error('Materia non confermata dal cloud: '+id),{code:'SYNC_NOT_CONVERGED'});
   // Compare both documents after the same validation/default normalization.
   // An administrator bank can omit optional metadata while the local model fills it.
   const remoteBank={...(remote.bank||{}),...normalizeBanks(remote.bank||{})};
   const remoteCourse=sync.applyBankToCourse(local,remoteBank,remote.bankRevision,remote.bankUpdatedAt);
   remoteCourse.cloudBankBase=remoteBank;
   // An acknowledged legacy bank may still omit defaults such as source.
   // Compare both validated representations while retaining metadata and content.
   const localBank=sync.bankPayload(local);
   const verifiedLocalBank={...localBank,...normalizeBanks(localBank)};
   if(sync.bankHash(verifiedLocalBank)!==sync.bankHash(sync.bankPayload(remoteCourse)))throw Object.assign(new Error('Banca ancora da sincronizzare: '+id),{code:'SYNC_NOT_CONVERGED'});
   const remoteEvents=new Set((remote.progress?.attempts||[]).map(a=>a.eventId));
   if((local.attempts||[]).some(a=>a.eventId&&!remoteEvents.has(a.eventId)))throw Object.assign(new Error('Progressi ancora da sincronizzare: '+id),{code:'SYNC_NOT_CONVERGED'});
  }
  mergeRemoteCourses(verifiedRows,{mergeProgressState:true});
  store.sync.lastPullAt=now();
  store.sync.mode='cloud-online';
  await saveStore(store);
  requireOperation(op);

  clearCloudFailure();await saveStore(store);requireOperation(op);
  const visibleCount=Object.values(store.courses||{}).filter(x=>qbank(shape(x)).length||shape(x).attempts.length).length;
  toast('Sync verificata: '+verifiedRows.length+' materie · visibili: '+visibleCount+' ☁️');
  render();
  return true;
 }catch(e){
  if(e?.code==='STALE_WORKSPACE'||!operationCurrent(op))return false;
  lastSyncError=true;
  console.warn('Full cloud pull',e);
  if(!convergenceFailureHandled)await recordCloudFailure(e,op);
  alert(e?.code==='SYNC_NOT_CONVERGED'?'Il cloud risponde, ma alcuni dati sono cambiati durante la sincronizzazione o non sono ancora confermati. I dati restano salvati su questo dispositivo. Ripeti «Sincronizza tutto» per verificare l’allineamento.':transientCloudError(e)?'Cloud temporaneamente non disponibile. Banche e progressi locali sono conservati; riprova più tardi.':'Lettura completa del cloud non riuscita:\n'+(e?.message||e));
  return false;
 }finally{
  if(operationCurrent(op)&&(!syncInFlight||runId===syncRunId)){syncInFlight=false;refreshSyncBadge();}
 }
}

function scheduleAutoSync(){
 if(!cloudState.user||!navigator.onLine)return;
 if(cloudRetryBlocked())return;
 if(session&&route.name==='session')return;
 clearTimeout(autoSyncTimer);
 autoSyncTimer=setTimeout(()=>cloudSync({silent:true}),1400);
}
async function startCloud(){
 await globalThis.UniSgiunglaLicense?.configure({
  getUserId:()=>sync.user()?.id||null,
  fetchLease:async({signal}={})=>{
   if(!sync.client)throw new Error('Backend locale non disponibile');
   if(navigator.onLine)await sync.recoverSession();
   sync.requireUser();
   let request=sync.client.rpc('quizlab_license');
   if(signal&&typeof request?.abortSignal==='function')request=request.abortSignal(signal);
   const {data,error,status}=await request;
   if(error){if(!Number(error.status)&&Number(status))error.status=Number(status);throw error;}
   return data;
  }
 });
 let activationPending=Promise.resolve(),activationAccount;
 function beginActivation(authSession,status){activationAccount=authSession?.user?.id||null;const pending=activate(authSession,status);activationPending=pending.catch(error=>console.warn('Account activation',error));return pending;}
 async function activate(authSession,status='cloud-ready'){
  const generation=workspaceGeneration+1;
  await selectWorkspaceForSession(authSession,{explicit:explicitAuthIntent});
  if(generation!==workspaceGeneration||(cloudState.user?.id||null)!==(authSession?.user?.id||null))return;
  const op=captureOperation();store.sync.mode=status;explicitAuthIntent=false;
  if(authSession?.user){
   try{await sync.ensurePendingRegistration();requireOperation(op);}catch(e){if(!operationCurrent(op))return;console.warn('Pending registration',e);}
   await globalThis.UniSgiunglaLicense?.refresh({force:false});if(!operationCurrent(op))return;
   if(globalThis.UniSgiunglaLicense?.status?.().userId!==(sync.user()?.id||null)){
    // A previous account's refresh may have been pending when Auth changed.
    await globalThis.UniSgiunglaLicense?.refresh({force:false});if(!operationCurrent(op))return;
   }
   await refreshAccessGate({renderBlocked:false});if(!operationCurrent(op))return;
   if(accessState.status==='active'&&baseAccessAllowed()){
    if(accessState.isAdmin)await refreshAdminPending();
    if(!operationCurrent(op))return;
    await hydrateCloudProfile();if(!operationCurrent(op))return;
    await cloudSync({silent:true});if(!operationCurrent(op))return;
    route.name='home';
    // Auth callbacks can complete after init's first render. Apply the requested
    // admin route only after this account's activation and sync are finished.
    await openAdminFromLocation();if(!operationCurrent(op))return;
   }else route.name='access';
  }
  render();
 }
 try{
  await applyDefaultCloudConfig();
  const initial=await sync.start({
   settings:store.settings||{},
   onAuthChange:async({event,session,status})=>{
    if(event==='TOKEN_REFRESHED'){
     if((cloudState.user?.id||null)===(session?.user?.id||null)){cloudState.status=status;refreshSyncBadge();return;}
    }
    if(event==='INITIAL_SESSION'&&activationAccount===(session?.user?.id||null)){await activationPending;return;}
    await beginActivation(session,status);
   }
  });
  if(initial?.user&&sync.user()?.id===initial.user.id&&activationAccount!==initial.user.id)await beginActivation({user:initial.user},initial.status);
  else if(!initial?.user&&cloudState.user)await beginActivation(null,initial.status);
  else if(!initial?.user&&activationAccount===undefined){cloudState=initial;await globalThis.UniSgiunglaLicense?.refresh();}
  await activationPending;
 }catch(e){console.warn('Cloud init',e);lastSyncError=true;render();}
}

function accessPage(){
 const pending=accessState.status==='pending';
 const checking=accessState.status==='unverified',expired=accessState.status==='expired';
 const title=checking?'Verifica accesso in corso':pending?'Richiesta inviata ⏳':expired?'Accesso scaduto':'Account sospeso ⛔';
 const text=checking?'Sto verificando l’accesso al laboratorio. I dati salvati restano sul dispositivo.':pending?'Il tuo account è stato creato correttamente. Ora deve essere approvato dall’amministratore di QuizLab.':expired?'La licenza è scaduta. Contatta l’amministratore per il rinnovo. I dati restano conservati.':'Questo account è stato sospeso dall’amministratore. I dati locali restano sul dispositivo ma le funzioni dell’app sono bloccate.';
 const label=checking?'Verifica in corso':pending?'In attesa':expired?'Scaduto':'Sospeso';
 page('<div class="stack"><section class="card hero jungle-hero"><div class="eyebrow">Accesso QuizLab</div><h1>'+title+'</h1><p class="subtle">'+text+'</p><div class="pill-row"><span class="pill '+(pending?'warn-pill':'')+'">'+label+'</span></div><div class="actions"><button class="btn secondary" data-action="refresh-access">Aggiorna stato</button><button class="btn ghost" data-action="sign-out">Esci</button></div></section></div>','QuizLab','Accesso',false);
}
function ensureAdminUsers(){return adminUsers||(adminUsers=createAdminUserListState());}
function requireAdminOperation(op){requireOperation(op);if(!accessState.isAdmin||!baseAccessAllowed())throw new Error('Accesso amministratore richiesto');}
async function refreshAdminData({usersOnly=false}={}){
 if(!accessState.isAdmin)return false;
 const op=captureOperation(),list=ensureAdminUsers(),request=++adminPageRequestId;
 list.loading=true;list.error='';list.expanded.clear();list.details.clear();
 if(route.name==='admin')adminPage();
 try{
  const [usersPage,storage,courses,retiredCourses,plans]=await Promise.all([
   sync.adminUsersPage(adminUserPageRequest(list)),
   usersOnly?adminData.storage:sync.adminStorageOverview(),
   usersOnly?adminData.courses:sync.adminCourseSummary(),
   usersOnly?adminData.retiredCourses:sync.adminRetiredCourses(),
   usersOnly?adminData.plans:sync.adminListPlans()
  ]);
  requireAdminOperation(op);
  if(request!==adminPageRequestId||list!==adminUsers)return false;
  applyAdminUserPage(list,usersPage);
  adminData={users:list.data.items,storage,courses,retiredCourses,plans,loaded:true};
  adminPendingCount=Number(list.data.summary.pending)||0;
  if(route.name==='admin')adminPage();return true;
 }catch(error){
  if(request!==adminPageRequestId||list!==adminUsers||!operationCurrent(op)||!accessState.isAdmin)return false;
  list.loading=false;list.error=error?.message||String(error);
  if(route.name==='admin')adminPage();throw error;
 }
}
async function refreshAdminPending(){
 if(!accessState.isAdmin){adminPendingCount=0;return 0;}
 if(cloudRetryBlocked())return adminPendingCount;
 try{
  const op=captureOperation();
  const usersPage=await sync.adminUsersPage(adminUserPageRequest(createAdminUserListState()));
  requireAdminOperation(op);
  adminPendingCount=Number(usersPage?.summary?.pending)||0;
 }catch(e){console.warn('Admin pending count',e);}
 return adminPendingCount;
}
async function toggleAdminUserDetail(userId,{retry=false}={}){
 if(!accessState.isAdmin)return;
 const list=ensureAdminUsers();
 if(list.loading||!list.data.items.some(user=>user.user_id===userId))return;
 if(list.expanded.has(userId)&&!retry){list.expanded.delete(userId);adminPage();return;}
 list.expanded.add(userId);
 if(!retry&&list.details.get(userId)?.data){adminPage();return;}
 if(list.details.get(userId)?.loading)return;
 const op=captureOperation(),request=adminPageRequestId,entry={loading:true,data:null,error:''};
 list.details.set(userId,entry);adminPage();
 try{
  const detail=await sync.adminUserDetail(userId);
  requireAdminOperation(op);
  if(request!==adminPageRequestId||list!==adminUsers||list.details.get(userId)!==entry)return;
  entry.loading=false;entry.data=detail;
 }catch(error){
  if(request!==adminPageRequestId||list!==adminUsers||!operationCurrent(op)||!accessState.isAdmin)return;
  entry.loading=false;entry.error=error?.message||String(error);
 }
 if(route.name==='admin')adminPage();
}
async function handleAdminUsersAction(action,userId){
 if(!accessState.isAdmin||route.name!=='admin')return;
 const list=ensureAdminUsers();
 if(list.loading)return;
 if(action==='admin-users-detail'||action==='admin-users-detail-retry'){await toggleAdminUserDetail(userId,{retry:action==='admin-users-detail-retry'});return;}
 if(action==='admin-users-filter')updateAdminUserFilters(list,readAdminUserFilters(document));
 else if(action==='admin-users-reset')resetAdminUserFilters(list);
 else if(action==='admin-users-previous'){if(list.page<=1)return;list.page--;}
 else if(action==='admin-users-next'){if(list.page>=Math.max(1,list.data.total_pages))return;list.page++;}
 else return;
 await refreshAdminData({usersOnly:true});
}
function localAdminMonitorAllowed(){return !!sync.session?.offlineIdentity&&baseAccessAllowed()&&globalThis.UniSgiunglaLicense?.status?.().isAdmin===true&&globalThis.UniSgiunglaLicense.status().userId===cloudState.user?.id;}
function adminPage(){if(!localAdminMonitorAllowed()){location.assign('./admin.html#cloud');return;}

 if(!baseAccessAllowed())return licensePage();
 if(localAdminMonitorAllowed()){page('<section class="card"><h3>Cloud temporaneamente indisponibile</h3><p>Ultima lettura egress conservata. Le operazioni amministrative richiedono una verifica online.</p></section><section class="card" data-egress-host></section>','Admin','Monitor in sola lettura',true);Promise.resolve().then(mountEgress);return;}
 if(!accessState.isAdmin)return setRoute('home',null);
 const list=ensureAdminUsers(),summary=list.data.summary||{},storage=adminData.storage||{},courses=adminData.courses||[],retiredCourses=adminData.retiredCourses||[];
 const globalCourseRows=[...courses].sort((a,b)=>String(a.subject).localeCompare(String(b.subject))).map(course=>
  '<div class="admin-user"><div><strong>'+esc(course.subject||course.course_id)+'</strong><div class="result-meta">'+Number(course.user_count||0)+' utenti · '+Number(course.attempt_count||0)+' tentativi · '+Number(course.exam_count||0)+' esami</div><div class="result-meta">Course ID: '+esc(course.course_id)+'</div></div><div class="actions"><button class="btn danger-btn compact-btn" data-action="admin-retire-course" data-course="'+esc(course.course_id)+'" data-subject="'+esc(course.subject||course.course_id)+'">Elimina per tutti</button></div></div>'
 ).join('');
 const retiredRows=[...retiredCourses].map(row=>
  '<div class="admin-user"><div><strong>'+esc(row.subject||row.course_id)+'</strong><div class="result-meta">Course ID: '+esc(row.course_id)+'</div><div class="result-meta">Ritirata: '+esc(row.retired_at?new Date(row.retired_at).toLocaleString('it-IT'):'—')+'</div></div><div class="actions"><button class="btn secondary compact-btn" data-action="admin-restore-course" data-course="'+esc(row.course_id)+'" data-subject="'+esc(row.subject||row.course_id)+'">Riabilita importazione</button></div></div>'
 ).join('');
 const actionsHtml=user=>{
  const approval=user.approval_status||user.account_status||'pending';
  if(cloudState.user?.id===user.user_id)return'<span class="pill ok-pill">🛡️ Amministratore</span>';
  const tools='<a class="btn secondary compact-btn" href="./admin.html?user='+encodeURIComponent(user.user_id)+'#accounts">'+(approval==='pending'?'Approva e scegli strumenti':'Strumenti e approvazione')+'</a>';
  if(approval==='pending')return tools+'<button class="btn compact-btn" data-action="admin-status" data-user="'+esc(user.user_id)+'" data-status="active">Approva</button><button class="btn ghost compact-btn" data-action="admin-status" data-user="'+esc(user.user_id)+'" data-status="suspended">Rifiuta</button>';
  if(approval==='active')return tools+'<button class="btn ghost compact-btn" data-action="admin-status" data-user="'+esc(user.user_id)+'" data-status="suspended">Sospendi</button>'+(adminEffectiveStatus(user)==='expired'?'<a class="btn secondary compact-btn" href="./admin.html?user='+encodeURIComponent(user.user_id)+'#accounts">Rinnova scadenza</a>':'');
  return tools+'<button class="btn secondary compact-btn" data-action="admin-status" data-user="'+esc(user.user_id)+'" data-status="active">Riattiva</button>';
 };
 const userList=renderAdminUserList(list,{selfId:cloudState.user?.id,plans:adminData.plans||[],actionsHtml});
 page('<div class="stack"><section class="card hero jungle-hero"><div class="eyebrow">Amministrazione</div><h1>Cabina di controllo 🌴</h1><div class="actions"><a class="btn secondary" href="./admin.html#accounts">Scadenze, piani e materie</a></div><div class="stats"><div class="stat"><span>In attesa</span><strong>'+Number(summary.pending||0)+'</strong></div><div class="stat"><span>Attivi</span><strong>'+Number(summary.active||0)+'</strong></div><div class="stat"><span>Sospesi</span><strong>'+Number(summary.suspended||0)+'</strong></div><div class="stat"><span>Scaduti</span><strong>'+Number(summary.expired||0)+'</strong></div><div class="stat"><span>Utenti totali</span><strong>'+Number(summary.total||0)+'</strong></div></div></section><section class="card"><div class="section-head"><div><div class="eyebrow">Utenti</div><h3 class="section-title">Approvazioni, accessi e statistiche</h3><p class="subtle">Le statistiche per materia si caricano quando apri i dettagli dell’account.</p></div><button class="btn ghost compact-btn" data-action="admin-refresh"'+(list.loading?' disabled':'')+'>Aggiorna</button></div>'+userList+'</section><section class="card" data-egress-host></section><section class="card"><div class="section-head"><div><div class="eyebrow">Cloud</div><h3 class="section-title">Spazio occupato</h3><p class="subtle">Misura i dati memorizzati, non il traffico in uscita. Il consumo di banda Supabase si verifica nella dashboard del provider; i valori del monitor indicano sempre fonte e data della rilevazione.</p></div></div><div class="stats"><div class="stat"><span>Database</span><strong>'+fmtBytes(storage.database_bytes)+'</strong></div><div class="stat"><span>Banche JSON</span><strong>'+fmtBytes(storage.banks_json_bytes)+'</strong></div><div class="stat"><span>Progressi JSON</span><strong>'+fmtBytes(storage.progress_json_bytes)+'</strong></div><div class="stat"><span>Tabelle QuizLab</span><strong>'+fmtBytes((Number(storage.banks_table_bytes)||0)+(Number(storage.progress_table_bytes)||0))+'</strong></div></div></section><details class="card danger-zone"><summary><strong>Pulizia globale delle materie cloud</strong> · '+courses.length+' materie</summary><div class="collapse-body"><p class="subtle">Solo amministratore. “Elimina per tutti” cancella tutte le copie cloud della materia e i relativi progressi. I dispositivi collegati la rimuoveranno al prossimo sync e non potranno ricrearla automaticamente da copie obsolete.</p><div class="admin-list">'+(globalCourseRows||'<div class="empty">Nessuna materia nel cloud.</div>')+'</div></div></details><details class="card"><summary><strong>Recupero Admin: materie ritirate</strong> · '+retiredCourses.length+' materie</summary><div class="collapse-body"><p class="subtle">Riabilitare una materia rimuove il blocco globale. I dati eliminati non vengono ricreati: per recuperarli serve un backup/import.</p><div class="admin-list">'+(retiredRows||'<div class="empty">Nessuna materia ritirata.</div>')+'</div></div></details></div>','Admin','Controllo accessi e cloud',true);
}
async function forceAppUpdate(){if(!navigator.onLine){toast('Serve Internet per aggiornare QuizLab');return;}try{await globalThis.quizlabApplyUpdate?.();toast('Controllo aggiornamenti completato.');}catch(error){toast('Aggiornamento non disponibile. I dati locali restano conservati.');}}

function cloudPage(){
 const cfg=store.settings||{},user=cloudState.user;
 if(user&&baseAccessAllowed()&&!featuresAllowed()){
  page('<section class="card hero"><div class="eyebrow">Account UniSgiunglaLab</div><h1>Account collegato</h1><p>'+esc(user.email||user.id)+'</p><p class="subtle">QuizLab web app non è abilitato per questo account. Materie e progressi restano conservati; la sincronizzazione di studio da questa app è sospesa.</p><div class="actions"><button class="btn secondary" data-action="license-refresh">Verifica strumenti</button><button class="btn secondary" data-action="profile">Profilo</button><button class="btn secondary" data-action="push-profile">Sincronizza profilo</button><button class="btn ghost" data-action="sign-out">Esci</button></div></section>','Account','Strumenti disponibili',false);return;
 }
 const configured=sync.configured(cfg)||sync.configured(DEFAULT_CLOUD_CONFIG||{});
 let body='<div class="stack"><section class="card hero jungle-hero"><div class="eyebrow">Cloud Sgiungla</div><h1>'+(user?'Account collegato ☁️':'Collega il tuo account')+'</h1><p class="subtle">'+(user?'Sei autenticato come '+esc(user.email||'utente')+'.':'Il database è pronto. Ora colleghiamo questa PWA al tuo account Supabase.')+'</p></section>';
 if(!configured){
  body+='<section class="card"><h2 class="section-title">Cloud non disponibile</h2><p class="subtle">La configurazione cloud della build non è completa. Un utente normale non deve inserire URL o chiavi tecniche.</p></section>';
 }else if(!user){
  body+='<section class="card"><h2 class="section-title">Account</h2><p class="subtle">L’accesso è ora nella pagina principale, così lo trovi subito all’apertura di QuizLab.</p><div class="actions"><button class="btn" data-action="home">Vai alla Home</button></div></section>';
 }else{
  body+='<section class="card"><h2 class="section-title">Sincronizzazione</h2><div class="sync-panel"><div><span>Account</span><strong>'+esc(user.email||user.id)+'</strong></div><div><span>Stato</span><strong>'+esc(syncBadgeModel().label)+'</strong></div><div><span>Ultima sincronizzazione</span><strong>'+esc(fmtSyncAgo(store.sync?.lastPullAt||store.sync?.lastPushAt)||'non ancora completata')+'</strong></div><div><span>Dati locali da sincronizzare</span><strong>'+((store.sync?.dirtyCourseIds||[]).length)+' materie</strong></div><div><span>Build</span><strong>v'+esc(APP_VERSION)+'</strong></div></div>'+(guestDataPending?'<div class="local-data-notice"><strong>🗂️ Dati locali non associati rilevati</strong><p class="subtle">Per sicurezza non sono stati collegati automaticamente a questo account.</p><div class="actions"><button class="btn secondary" data-action="keep-local-separate">Mantieni separati</button><button class="btn" data-action="import-local-data">Importa dati locali</button></div></div>':'')+'<div class="actions"><button class="btn" data-action="sync-all">Sincronizza tutto</button><button class="btn secondary" data-action="force-app-update">↻ Aggiorna QuizLab</button><button class="btn secondary" data-action="push-profile">Sincronizza profilo</button>'+(accessState.isAdmin||localAdminMonitorAllowed()?'<button class="btn secondary" data-action="open-admin">🛡️ Admin'+(adminPendingCount?' · '+adminPendingCount:'')+'</button>':'')+'<button class="btn ghost" data-action="sign-out">Esci</button></div><p class="subtle">La sincronizzazione è automatica. Il pulsante serve solo per forzarla subito manualmente.</p></section>';
 }
 body+=cloudNoticeHtml()+'</div>';page(body,'Cloud','Account e sync',true);
}
function searchPage(){searchLimit=30;const c=course(),chs=uniq(qbank(c).map(q=>Number(q.chapter)).filter(Boolean)).sort((a,b)=>a-b);page('<div class="stack"><section class="card"><h2 class="section-title">Cerca nella banca</h2><label>Parola o frase<input id="searchInput" placeholder="es. media aritmetica"></label><div class="row"><label>Cerca in<select id="searchWhere"><option value="question">Domanda</option><option value="answers">Risposte</option><option value="explanation">Spiegazione</option><option value="topic">Argomento</option><option value="all">Tutto</option></select></label><label>Origine<select id="searchSource"><option value="all">Tutte</option><option value="official">Ufficiali</option><option value="ai">AI</option></select></label></div><div class="row"><label>Stato<select id="searchStatus"><option value="all">Tutte</option><option value="unseen">Mai viste</option><option value="correct">Corrette</option><option value="wrong">Sbagliate</option><option value="recovery">Da recuperare</option><option value="marked">Segnate</option><option value="historical">Errori storici</option><option value="warning">Con warning</option><option value="warning_unresolved">Warning irrisolti</option></select></label><label>Difficoltà<select id="searchDifficulty"><option value="all">Tutte</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label></div><label>Capitolo<select id="searchChapter"><option value="all">Tutti</option>'+chs.map(ch=>'<option value="'+ch+'">'+ch+'</option>').join('')+'</select></label></section><section class="card" id="searchResults"><div class="empty">Inserisci una ricerca o applica almeno un filtro.</div></section></div>',c.subject,'Esplora banca',true);setTimeout(()=>{for(const id of ['searchInput','searchWhere','searchSource','searchStatus','searchDifficulty','searchChapter']){const el=document.getElementById(id);if(el)el.addEventListener(id==='searchInput'?'input':'change',updateSearch);}},0);}
function searchMatches(){const c=course(),term=norm(document.getElementById('searchInput')?.value).toLowerCase(),where=document.getElementById('searchWhere')?.value||'question',src=document.getElementById('searchSource')?.value||'all',status=document.getElementById('searchStatus')?.value||'all',diff=document.getElementById('searchDifficulty')?.value||'all',ch=document.getElementById('searchChapter')?.value||'all',latest=latestMap(c);const active=!!term||src!=='all'||status!=='all'||diff!=='all'||ch!=='all';if(!active)return[];return qbank(c).filter(q=>{if(src!=='all'&&q.source!==src)return false;if(diff!=='all'&&q.difficulty!==diff)return false;if(ch!=='all'&&Number(q.chapter)!==Number(ch))return false;const a=latest.get(q.id);if(status==='unseen'&&a)return false;if(status==='correct'&&!a?.correct)return false;if(status==='wrong'&&(!a||a.correct))return false;if(status==='recovery'&&!c.pendingReview.includes(q.id))return false;if(status==='marked'&&!c.marked.includes(q.id))return false;if(status==='historical'&&!c.historicalWrong.includes(q.id))return false;if(status==='warning'&&!q.validationWarning)return false;if(status==='warning_unresolved'&&(!q.validationWarning||!['unresolved','source_not_found',''].includes(norm(q.warningResolution?.status).toLowerCase())))return false;if(!term)return true;const fields={question:[q.text],answers:(q.options||[]).map(o=>o.text),explanation:[q.explanation],topic:[q.topic,q.topicId,q.chapterTitle],all:[q.text,q.explanation,q.reference,q.topic,q.topicId,q.chapterTitle,...(q.options||[]).map(o=>o.text)]};return (fields[where]||fields.all).filter(Boolean).join(' ').toLowerCase().includes(term);});}
function updateSearch(reset=true){if(reset!==false)searchLimit=30;const r=searchMatches(),box=document.getElementById('searchResults');if(!box)return;const visible=r.slice(0,searchLimit);box.innerHTML='<div class="toolbar"><strong>'+r.length+' risultati · visualizzati '+visible.length+'</strong>'+(r.length?'<button class="btn secondary" data-action="study-search">Studia tutti</button><button class="btn secondary" data-action="train-search">Allenati sui risultati</button>':'')+'</div>'+visible.map(q=>'<div class="result"><div class="result-title">'+esc(q.text)+'</div><div class="result-meta">Cap. '+esc(q.chapter)+' · '+(q.source==='official'?'Ufficiale':'AI')+' · '+esc(q.difficulty||'medium')+(q.topic?' · '+esc(q.topic):'')+'</div><button class="btn ghost" data-action="open-question" data-qid="'+esc(q.id)+'">Apri</button></div>').join('')+(visible.length<r.length?'<button class="btn secondary" data-action="search-more">Mostra altri 30</button>':'');}

function normalizeQuestion(raw,source){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.options)||raw.options.length!==4)return null;
 const id=norm(raw.id),chapter=Number(raw.chapter??raw.chapterNumber),text=norm(raw.text??raw.question);
 if(!id||id.length>256||['__proto__','prototype','constructor'].includes(id)||!Number.isSafeInteger(chapter)||chapter<1||chapter>100000||!text||text.length>100000)return null;
 const options=raw.options.map((o,i)=>({letter:norm(o?.letter||['A','B','C','D'][i]).toUpperCase(),optionId:norm(o?.optionId||o?.id||('opt_'+(i+1))),text:norm(o?.text??o)}));
 if(options.some(o=>!/^[A-D]$/.test(o.letter)||!o.optionId||!o.text||o.text.length>100000)||new Set(options.map(o=>o.letter)).size!==4||new Set(options.map(o=>o.optionId)).size!==4)return null;
 let correct=norm(raw.correct||raw.correctAnswer).toUpperCase();
 const coi=norm(raw.correctOptionId||raw.correct_option_id);
 if(coi){const match=options.find(o=>o.optionId===coi);if(!match)return null;correct=match.letter;}
 if(!options.some(o=>o.letter===correct))return null;
 return {...raw,id,source,chapter,text,options,correct,correctOptionId:coi||options.find(o=>o.letter===correct).optionId,explanation:norm(raw.explanation||raw.spiegazione),reference:norm(raw.reference||raw.fonte||''),difficulty:['easy','medium','hard'].includes(String(raw.difficulty||'').toLowerCase())?String(raw.difficulty).toLowerCase():'medium'};
}
function normalizeBanks(raw){
 const out={officialBank:[],aiBank:[]},ids=new Set();
 for(const [key,source] of [['officialBank','official'],['aiBank','ai']]){
  const rows=raw?.[key]??[];
  if(!Array.isArray(rows)||rows.length>50000)throw new Error('Banca non valida o troppo grande: '+key);
  for(let i=0;i<rows.length;i++){
   const q=normalizeQuestion(rows[i],source);
   if(!q)throw new Error('Domanda non valida in '+key+', posizione '+(i+1));
   if(ids.has(q.id))throw new Error('ID domanda duplicato tra banche: '+q.id);
   ids.add(q.id);out[key].push(q);
  }
 }
 const content={...out,topicMap:raw?.topicMap??null,aiWorkflow:raw?.aiWorkflow||{},bankMeta:raw?.bankMeta||{}};
 if(ids.size>20000||new Blob([JSON.stringify(content)]).size>8*1024*1024)throw new Error('Banca oltre la quota: massimo 20.000 domande e 8 MB');
 return out;
}
function cleanImportJson(value,depth=0){
 if(depth>50)throw new Error('JSON troppo annidato');
 if(Array.isArray(value))return value.map(x=>cleanImportJson(x,depth+1));
 if(value&&typeof value==='object'){
  const out={};
  for(const [key,item] of Object.entries(value)){
   if(['__proto__','constructor','prototype'].includes(key))throw new Error('Chiave JSON riservata: '+key);
   out[key]=cleanImportJson(item,depth+1);
  }
  return out;
 }
 if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Numero JSON non finito');
 return value;
}
function mergeById(oldRows,newRows){const m=new Map((oldRows||[]).map(q=>[q.id,q]));for(const q of newRows)m.set(q.id,{...(m.get(q.id)||{}),...q});return [...m.values()];}
async function removeCourseFromDevice(id){
 const op=captureOperation();
 const c=course(id);if(!c)return;
 if(!confirm('Rimuovere “'+(c.subject||id)+'” solo da questo dispositivo?\n\nLa materia resterà nel cloud e sugli altri dispositivi.'))return;
 delete store.courses[id];
 store.sync=store.sync||{};
 store.sync.hiddenCourseIds=uniq([...(store.sync.hiddenCourseIds||[]),id]);
 store.sync.dirtyCourseIds=(store.sync.dirtyCourseIds||[]).filter(x=>x!==id);
 store.sync.dirtyBankCourseIds=(store.sync.dirtyBankCourseIds||[]).filter(x=>x!==id);
 store.sync.lastLocalChangeAt=now();
 const saved=await saveStore(store);
 if(!operationCurrent(op))return;store=saved;
 route={name:'home',courseId:null};session=null;
 toast('Materia rimossa solo da questo dispositivo');
 render();
}

async function deleteCourseEverywhere(id){
 const op=captureOperation();
 const c=course(id);if(!c)return;
 const subject=c.subject||id;
 if(c.managedByAdmin){alert('Questa materia è gestita dall’amministratore. Puoi nasconderla su questo dispositivo; la banca assegnata viene aggiornata dall’amministratore.');return;}
 if(!cloudState.user||accessState.status!=='active'){
  alert('Per eliminare definitivamente dal cloud devi essere collegato con un account attivo.');
  return;
 }
 if(!navigator.onLine){
  alert('Per l’eliminazione definitiva serve una connessione Internet.');
  return;
 }
 if(!confirm('ELIMINAZIONE DEFINITIVA\n\nEliminare “'+subject+'” dal cloud e da questo dispositivo?\n\nVerranno cancellati banca, progressi, tentativi, esami e ripasso associati alla materia. Questa operazione non è annullabile salvo backup.'))return;
 const typed=prompt('Per confermare scrivi ELIMINA');
 if(typed!=='ELIMINA'){toast('Eliminazione annullata');return;}
 try{
  await sync.deleteCloudCourse(id);
  requireOperation(op);
  delete store.courses[id];
  store.sync=store.sync||{};
  store.sync.hiddenCourseIds=uniq([...(store.sync.hiddenCourseIds||[]),id]);
  store.sync.dirtyCourseIds=(store.sync.dirtyCourseIds||[]).filter(x=>x!==id);
  store.sync.dirtyBankCourseIds=(store.sync.dirtyBankCourseIds||[]).filter(x=>x!==id);
  store.sync.lastLocalChangeAt=now();
  store.sync.lastPushAt=now();
  const saved=await saveStore(store);
  requireOperation(op);store=saved;
  route={name:'home',courseId:null};session=null;
  toast('Materia eliminata definitivamente ☁️');
  render();
 }catch(e){
  if(e?.code==='STALE_WORKSPACE'||!operationCurrent(op))return;
  alert('Eliminazione non riuscita:\n'+(e?.message||e));
 }
}

async function importPack(p){
 if(!featuresAllowed())throw new Error('Accesso da verificare prima dell’importazione');
 if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('JSON non valido');
 p=cleanImportJson(p);
 const op=captureOperation();
 if(p.schema===BACKUP_SCHEMA){
  if(!p.store?.courses||typeof p.store.courses!=='object'||Array.isArray(p.store.courses))throw new Error('Backup non valido');
  const importedEntries=Object.entries(p.store.courses);
  if(importedEntries.length>500)throw new Error('Backup troppo grande: massimo 500 materie');
  // Validate the entire file before writes or cloud operations.
  const validated=importedEntries.map(([id,rawCourse])=>{
   assertCourseId(id);
   if(!rawCourse||typeof rawCourse!=='object'||Array.isArray(rawCourse))throw new Error('Materia backup non valida: '+id);
   const banks=normalizeBanks(rawCourse);
   return [id,shape({...rawCourse,...banks})];
  });
  const nextCourses={...(store.courses||{})};
  const importedIds=[];
  const skippedIds=[];
  for(const [id,incoming] of validated){
   requireStudyOperation(op);
   const existing=store.courses?.[id]?shape(store.courses[id]):null;
   if(existing?.managedByAdmin){skippedIds.push(id);continue;}
   if(cloudState.user&&accessState.status==='active'){
    try{await sync.restoreMyCourse(id);}catch(e){
     if(String(e?.message||e).toLowerCase().includes('retired')){skippedIds.push(id);continue;}
     throw e;
    }
    requireStudyOperation(op);
   }
   let merged=incoming;
   if(existing){
    const mergedBank=sync.mergeBanks(sync.bankPayload(existing),sync.bankPayload(incoming));
    const progress=sync.mergeProgress(sync.progressPayload(existing),sync.progressPayload(incoming));
    merged=shape({...sync.applyBankToCourse(existing,mergedBank),...progress});
   }
   normalizeBanks(merged);
   merged.bankUpdatedAt=now();merged.updatedAt=merged.bankUpdatedAt;
   // Backup metadata cannot import ownership or administrator-managed status.
   merged.managedByAdmin=existing?.managedByAdmin||false;
   merged.cloudBankRevision=existing?.cloudBankRevision||0;
   merged.cloudRevision=existing?.cloudRevision||0;
   merged.cloudBankBase=existing?.cloudBankBase||null;
   nextCourses[id]=merged;
   importedIds.push(id);
  }
  requireStudyOperation(op);
  // Restore is deliberately a conservative merge, preserving newer local
  // progress and applying explicit reset/tombstone metadata from the backup.
  store.courses=nextCourses;
  store.profile=store.profile||{};
  store.settings=store.settings||{};
  store.sync=store.sync||{};
  store.sync.hiddenCourseIds=(store.sync.hiddenCourseIds||[]).filter(id=>!importedIds.includes(id));
  store.sync.dirtyCourseIds=uniq([...(store.sync.dirtyCourseIds||[]),...importedIds]);
  store.sync.dirtyBankCourseIds=uniq([...(store.sync.dirtyBankCourseIds||[]),...importedIds]);
  store.sync.lastLocalChangeAt=now();
  if(cloudState.user)store.sync.ownerId=cloudState.user.id;
  const saved=await saveStore(store);
  requireOperation(op);store=saved;

  if(cloudState.user&&accessState.status==='active'&&navigator.onLine){
   await cloudSync({silent:true});
  }else{
   scheduleAutoSync();
  }
  return 'Backup unito ai dati locali · '+importedIds.length+' materie'+(skippedIds.length?' · '+skippedIds.length+' gestite dall’admin/ritirate saltate':'')+' · account e profilo preservati';
 }
 if(p.schema!==BANK_SCHEMA)throw new Error('Serve una Banca QuizLab COMPLETA o un Backup QuizLab.');
 const id=norm(p.course?.courseId),subject=norm(p.course?.subject||id);
 assertCourseId(id);
 const {officialBank:off,aiBank:ai}=normalizeBanks(p);
 if(!off.length&&!ai.length)throw new Error('Nessuna domanda valida');
 assertBankEditable(store.courses[id]);
 const c=shape(store.courses[id]||emptyCourse(subject));
 c.subject=subject;
 c.officialBank=mergeById(c.officialBank,off);
 c.aiBank=mergeById(c.aiBank,ai);
 normalizeBanks(c);
 if(Object.hasOwn(p,'topicMap'))c.topicMap=p.topicMap;
 if(Object.hasOwn(p,'aiWorkflow'))c.aiWorkflow=p.aiWorkflow||{};
 if(cloudState.user&&accessState.status==='active'){await sync.restoreMyCourse(id);requireStudyOperation(op);}
 requireStudyOperation(op);
 store.sync.hiddenCourseIds=(store.sync.hiddenCourseIds||[]).filter(x=>x!==id);
 await saveCourse(id,c,{bankDirty:true});
 return subject+': '+off.length+' ufficiali · '+ai.length+' AI';
}
function exportCourse(id){const c=course(id);if(!c)return;download(fileName(c.subject)+'_QuizLab_banca_COMPLETA_mobile.json',{schema:BANK_SCHEMA,version:2,exportedAt:now(),course:{courseId:id,subject:c.subject},officialBank:c.officialBank,aiBank:c.aiBank,topicMap:c.topicMap,aiWorkflow:c.aiWorkflow});}
function backup(){download('QuizLab_Mobile_BACKUP_'+new Date().toISOString().slice(0,10)+'.json',{schema:BACKUP_SCHEMA,version:1,exportedAt:now(),store});}

function baseAccessAllowed(){
 return globalThis.UniSgiunglaLicense?.canUseFeatures()===true;
}
function featuresAllowed(){return globalThis.UniSgiunglaLicense?.canUseFeature?.('quizlab_pwa')===true;}
function licensePage(){
 session=null;
 if(examTimer){clearInterval(examTimer);examTimer=null;}
 const user=cloudState.user;
 const license=globalThis.UniSgiunglaLicense?.status?.() || {};
 const moduleDenied=baseAccessAllowed()&&!featuresAllowed();
 const blockedTitle=moduleDenied?'QuizLab web app non abilitato':({expired:'Account scaduto',suspended:'Account sospeso',pending:'Account in attesa di approvazione',active:'Verifica di accesso scaduta'}[license.status] || 'Accesso da verificare');
 const cloudBlocked=license.cloudUnavailable&&license.status==='active';
 let body='<section class="card hero"><div class="eyebrow">Accesso UniSgiunglaLab</div><h1>'+(user?blockedTitle:'Accedi a UniSgiunglaLab')+'</h1><p class="subtle">'+(moduleDenied?'Il tuo account è attivo, ma questo strumento non è incluso. L’amministratore può modificarlo dalla scheda dell’account. Materie, progressi e dati in attesa restano conservati.':user?(cloudBlocked?'Il cloud è temporaneamente non disponibile e serve una nuova verifica online per continuare. L’accesso locale resta limitato a 24 ore dall’ultima verifica, o alla scadenza dell’account se precedente. Materie, progressi e modifiche in attesa restano conservati. Quando il servizio torna disponibile, premi Verifica accesso.':'L’accesso richiede una licenza valida e una verifica almeno ogni 24 ore. I dati salvati restano sul dispositivo. Contatta l’amministratore per il rinnovo.'):'Accedi con il tuo account UniSgiunglaLab. Le funzioni disponibili dipendono dai moduli abilitati.')+'</p>';
 if(!user)body+='<label>Email<input id="authEmail" type="email" autocomplete="email"></label><label>Password<input id="authPassword" type="password" autocomplete="current-password" minlength="8"></label><div class="actions"><button class="btn" data-action="sign-in">Accedi</button><button class="btn secondary" data-action="sign-up">Crea account</button></div>';
 else body+='<p>'+esc(user.email||user.id)+'</p><div class="actions"><button class="btn" data-action="license-refresh">Verifica accesso</button><button class="btn secondary" data-action="sign-out">Esci</button></div>';
 page(body+'</section>','QuizLab','Verifica accesso',false);
}
window.addEventListener('unisgiungla-license-change',()=>{if(!featuresAllowed()){session=null;clearTimeout(autoSyncTimer);}render();});

function mountEgress(){
 const host=app.querySelector('[data-egress-host]'),id=cloudState.user?.id;
 if(host&&id&&(accessState.isAdmin||localAdminMonitorAllowed()))globalThis.QuizLabEgress?.mount(host,{accountId:id,isAdmin:true,localOnly:localAdminMonitorAllowed(),currentAccount:()=>cloudState.user?.id,request:async(_,body)=>{const session=await sync.client.auth.getSession(),token=session.data?.session?.access_token;if(!token)throw Error('Cloud non disponibile');const config=globalThis.QUIZLAB_LAB_CONFIG;if(config?.mode!=='production'||config.apiBase!=="https://eqrcdvhhfrkpmnzqoerr.supabase.co")throw Error('Configurazione non valida');const response=await fetch(config.runtimeBase+'/egress',{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const value=await response.json();if(!response.ok)throw Error(value.message||'Monitor non disponibile');return value;}});
}
function render(){
 Promise.resolve().then(mountEgress).catch(()=>{});
 if(!baseAccessAllowed()){licensePage();return;}
 if(!featuresAllowed()&&!['profile','cloud','admin'].includes(route.name)){licensePage();return;}
 if(cloudState.user&&accessState.status!=='active'&&route.name!=='access'){route.name='access';session=null;}
 if(route.name==='home')home();else if(route.name==='dashboard')dashboard();else if(route.name==='training')training(route.presetChapter);else if(route.name==='session')sessionView();else if(route.name==='results')results();else if(route.name==='review')reviewPage();else if(route.name==='search')searchPage();else if(route.name==='profile')profilePage();else if(route.name==='cloud')cloudPage();else if(route.name==='access')accessPage();else if(route.name==='admin')adminPage();else home();
}

app.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
 if((session?.finishing||session?.answers?.[current()?.id]?.saving)&&['answer','confirm','exam-prev','exam-next','mark','next','study-prev','study-next'].includes(a))return;
 if(a==='study-panel'){try{await openStudyPanel(b.dataset.studyTab||'goals');}catch(error){toast(error.message);}return;}
 if(a==='sign-out'){globalThis.QuizLabStudyUI?.close();navigator.serviceWorker?.controller?.postMessage({type:'QUIZLAB_PUSH_POLICY',userId:null});try{await studyRequest('revoke-device',{device_id:store.sync.clientId});}catch{}}
 const authActions=['sign-in','sign-up','sign-out','refresh-access','license-refresh','cloud','home','toggle-theme'];
 const accountActions=[...authActions,'profile','save-profile','push-profile','avatar-pick','force-app-update'];
 if(!baseAccessAllowed()&&!authActions.includes(a)){licensePage();return;}
 if(baseAccessAllowed()&&!featuresAllowed()&&!accountActions.includes(a)){licensePage();return;}
 if(a==='license-refresh'){await globalThis.UniSgiunglaLicense?.refresh();await refreshAccessGate({renderBlocked:false,force:true});render();return;}
if(a==='toggle-theme'){applyTheme(currentTheme==='dark'?'light':'dark');return;}
if(a==='home'){setRoute('home',null);return;}
if(a==='back'){
 if(route.name==='dashboard'){setRoute('home',null);return;}
 if(route.name==='session'){
  setRoute('dashboard');
  if(cloudState.user&&navigator.onLine)await cloudSync({silent:true});
  return;
 }
 setRoute('dashboard');
 return;
}
if(a==='profile'){setRoute('profile',route.courseId);return;}
if(a==='cloud'){setRoute('cloud',route.courseId);return;}
if(a==='save-cloud-config'){
 toast('Il collegamento cloud è già configurato.');return;
}
if(a==='reset-cloud-config'){delete store.settings.supabaseUrl;delete store.settings.supabasePublishableKey;await saveStore(store);cloudState={status:'local-only',user:null};cloudPage();return;}
if(a==='sign-up'){
 const email=norm(document.getElementById('authEmail')?.value),password=String(document.getElementById('authPassword')?.value||'');
 if(!email||password.length<8){toast('Email valida e password di almeno 8 caratteri');return;}
 const {data,error}=await sync.signUp(email,password,location.origin+location.pathname);if(error){alert(error.message);return;}
 toast(data?.session?'Account creato e collegato':'Controlla la mail per confermare l’account');return;
}
if(a==='sign-in'){
 const email=norm(document.getElementById('authEmail')?.value),password=String(document.getElementById('authPassword')?.value||'');
 explicitAuthIntent=true;const {error}=await sync.signIn(email,password);if(error){explicitAuthIntent=false;alert(error.message);return;}toast('Accesso effettuato ☁️');return;
}
if(a==='sign-out'){
 await globalThis.UniSgiunglaLicense?.clear();
 try{await sync.signOut();}catch(error){console.warn('Device logout',error);}
 // Local credentials are cleared even when the network rejects logout.
 // A newer login may have completed while the old logout request was pending.
 if(!sync.user())await selectWorkspaceForSession(null,{explicit:false});
 toast('Disconnesso dal cloud');render();return;
}
if(a==='refresh-access'){
 try{
  await globalThis.UniSgiunglaLicense?.refresh();
  await refreshAccessGate({renderBlocked:false,force:true});
  if(accessState.status==='active'&&featuresAllowed()){await hydrateCloudProfile();await cloudSync({silent:true});setRoute('home',null);}
  else{route.name='access';render();}
 }catch(e){alert(e.message||e);}
 return;
}
if(a==='open-admin'){
 if(localAdminMonitorAllowed()){setRoute('admin',null);return;}
 try{await refreshAdminData();setRoute('admin',null);}catch(e){alert('Dashboard Admin non disponibile:\n'+(e?.message||e));}
 return;
}
if(a.startsWith('admin-users-')){
 try{await handleAdminUsersAction(a,b.dataset.user);}catch(error){if(route.name!=='admin')alert(error?.message||error);}
 return;
}
if(a==='admin-refresh'){
 try{await refreshAdminData();adminPage();}catch(e){alert(e.message||e);}
 return;
}
if(a==='admin-retire-course'){
 const op=captureOperation();
 const courseId=b.dataset.course,subject=b.dataset.subject||courseId;
 if(!courseId)return;
 if(!confirm('ELIMINAZIONE GLOBALE\n\nEliminare “'+subject+'” dal cloud per tutti gli utenti?\n\nVerranno cancellate tutte le copie cloud della materia e tutti i progressi associati.'))return;
 const typed=prompt('Per confermare scrivi esattamente: ELIMINA PER TUTTI');
 if(typed!=='ELIMINA PER TUTTI'){toast('Eliminazione globale annullata');return;}
 try{
  requireAdminOperation(op);
  const out=await sync.adminRetireCourse(courseId);
  requireAdminOperation(op);
  delete store.courses[courseId];
  store.sync.hiddenCourseIds=uniq([...(store.sync?.hiddenCourseIds||[]),courseId]);
  store.sync.dirtyCourseIds=(store.sync?.dirtyCourseIds||[]).filter(id=>id!==courseId);
  store.sync.dirtyBankCourseIds=(store.sync?.dirtyBankCourseIds||[]).filter(id=>id!==courseId);
  store.sync.lastLocalChangeAt=now();
  const saved=await saveStore(store);requireAdminOperation(op);store=saved;
  await refreshAdminData();
  requireAdminOperation(op);
  toast('Materia eliminata per tutti · '+Number(out.deleted_banks||0)+' copie cloud');
  adminPage();
 }catch(e){if(e?.code==='STALE_WORKSPACE'||!operationCurrent(op))return;alert('Eliminazione globale non riuscita:\n'+(e?.message||e));}
 return;
}
if(a==='admin-restore-course'){
 const courseId=b.dataset.course,subject=b.dataset.subject||courseId;
 if(!courseId)return;
 if(!confirm('Riabilitare “'+subject+'”?\n\nQuesto rimuove il blocco globale. I dati cancellati non vengono ripristinati automaticamente.'))return;
 try{
  await sync.adminRestoreCourse(courseId);
  await refreshAdminData();
  toast('Materia riabilitata ✅ · ora può essere reimportata');
  adminPage();
 }catch(e){alert('Riabilitazione non riuscita:\n'+(e?.message||e));}
 return;
}
if(a==='admin-status'){
 const userId=b.dataset.user,status=b.dataset.status;
 const label=status==='active'?'approvare/riattivare':'sospendere';
 if(!confirm('Confermi di '+label+' questo account?'))return;
 try{await sync.adminSetUserStatus(userId,status);await refreshAdminData();toast(status==='active'?'Account attivato ✅':'Account sospeso ⛔');adminPage();}catch(e){alert(e.message||e);}
 return;
}
if(a==='push-profile'){await saveProfile({pushOnly:true});return;}
if(a==='import-local-data'){
 const userId=cloudState.user?.id;if(!userId)return;
 const typed=prompt('Questa operazione copierà/mergerà nel tuo account i dati locali non associati presenti su questo dispositivo.\n\nPer continuare scrivi esattamente: IMPORTA');
 if(typed!=='IMPORTA')return;
 store=await selectWorkspace(userId,{importGuest:true,markGuestHandled:true});
 guestDataPending=false;
 store.sync.ownerId=userId;await saveStore(store);
 await cloudSync({silent:false});cloudPage();return;
}
if(a==='keep-local-separate'){
 const userId=cloudState.user?.id;if(!userId)return;
 store=await selectWorkspace(userId,{importGuest:false,markGuestHandled:true});
 guestDataPending=false;
 store.sync.ownerId=userId;await saveStore(store);cloudPage();return;
}
if(a==='sync-all'){await forceCloudPullAll();return;}
if(a==='force-app-update'){await forceAppUpdate();return;}


if(a==='avatar-pick'){document.getElementById('avatarPicker')?.click();return;}
if(a==='save-profile'){await saveProfile();return;}
if(a==='import'){picker.value='';picker.click();return;}if(a==='backup'){backup();return;}if(a==='open'){setRoute('dashboard',b.dataset.id);return;}if(a==='export'){exportCourse(b.dataset.id||route.courseId);return;}
if(a==='training'){setRoute('training');return;}if(a==='review-page'){setRoute('review');return;}if(a==='search'){setRoute('search');return;}if(a==='review'){review(b.dataset.kind);return;}
if(a==='train-chapter'){route.presetChapter=Number(b.dataset.chapter);route.name='training';session=null;render();return;}
if(a==='start-chapter'){const c=course(),ch=Number(document.getElementById('chapterSelect').value),src=document.getElementById('chapterSource').value,p=filterSource(qbank(c).filter(q=>Number(q.chapter)===ch),src),n=amountValue('chapterAmount',p.length);startSession(selectTraining(p,n,src),'Allenamento capitolo '+ch,'chapter');return;}
if(a==='start-range'){const c=course(),f=Number(document.getElementById('rangeFrom').value),t=Number(document.getElementById('rangeTo').value),src=document.getElementById('rangeSource').value,p=filterSource(qbank(c).filter(q=>Number(q.chapter)>=Math.min(f,t)&&Number(q.chapter)<=Math.max(f,t)),src),n=amountValue('rangeAmount',p.length);startSession(selectTraining(p,n,src),'Intervallo capitoli '+Math.min(f,t)+'–'+Math.max(f,t),'range');return;}
if(a==='start-full'){const c=course(),src=document.getElementById('fullSource').value,remain=filterSource(qbank(c),src).filter(q=>!(c.fullCampaign?.seenIds||[]).includes(q.id)),n=amountValue('fullAmount',remain.length),qs=await fullCampaignPool(c,n,src);startSession(qs,'Materia completa','full');return;}
if(a==='remove-local-course'){await removeCourseFromDevice(route.courseId);return;}
if(a==='delete-cloud-course'){await deleteCourseEverywhere(route.courseId);return;}
if(a==='reset-cycle'){resetCycle();return;}
if(a==='reset-performance'){await resetPerformance();return;}
if(a==='reset-review'){await resetReview();return;}
if(a==='exam'||a==='start-exam'){const c=course(),qs=selectTraining(qbank(c),31,'mixed');startSession(qs,'Simulazione esame','exam');return;}
if(a==='answer'){const q=current();if(!q)return;session.answers[q.id]={...(session.answers[q.id]||{}),selected:b.dataset.letter};render();return;}
if(a==='confirm'){await confirmAnswer();return;}if(a==='next'){await nextQuestion();return;}
if(a==='exam-prev'){if(session.index>0){session.index--;session.questionShownAt=Date.now();render();}return;}
if(a==='exam-next'){
 const active=session,op=captureOperation();if(!active)return;
 if(session.index>=session.questions.length-1){await finishExam(false);}
 else{await confirmExamAnswer();if(!operationCurrent(op)||session!==active)return;session.index++;session.questionShownAt=Date.now();render();}
 return;
}
if(a==='study-prev'){if(session.index>0){session.index--;render();}return;}if(a==='study-next'){if(session.index>=session.questions.length-1){setRoute('dashboard');syncAfterLocalStudy();}else{session.index++;render();}return;}
if(a==='mark'){const c=course(),q=current(),set=new Set(c.marked),meta=ensureCourseSyncMeta(c),at=now();if(set.has(q.id)){set.delete(q.id);meta.markedState[q.id]={value:false,at};}else{set.add(q.id);meta.markedState[q.id]={value:true,at};}c.marked=[...set];await saveCourse(route.courseId,c);render();return;}
if(a==='dashboard'){setRoute('dashboard');return;}
if(a==='retry-wrong'){const c=course(),by=new Map(qbank(c).map(q=>[q.id,q])),ids=session.mode==='exam'?(session.examResult?.wrong||[]):Object.entries(session.answers).filter(([,v])=>v.confirmed&&!v.correct).map(([id])=>id),qs=ids.map(id=>by.get(id)).filter(Boolean);startSession(qs,'Errori sessione','review');return;}
if(a==='open-question'){const q=qbank(course()).find(x=>x.id===b.dataset.qid);if(q)startSession([q],'Domanda','study');return;}
if(a==='search-more'){searchLimit+=30;updateSearch(false);return;}
if(a==='study-search'){startSession(searchMatches(),'Studio risultati','study');return;}if(a==='train-search'){startSession(shuffle(searchMatches()),'Risultati ricerca','search');return;}
});

app.addEventListener('keydown',async event=>{if(event.key!=='Enter'||event.target.id!=='adminUsers-search'||route.name!=='admin')return;event.preventDefault();try{await handleAdminUsersAction('admin-users-filter');}catch(error){if(route.name!=='admin')alert(error?.message||error);}});

picker.addEventListener('change',async()=>{const f=picker.files?.[0];if(!f)return;const op=captureOperation();try{if(f.size>25*1024*1024)throw new Error('File troppo grande: massimo 25 MB');const raw=await f.text();requireOperation(op);const msg=await importPack(JSON.parse(raw));requireOperation(op);toast('Importazione OK · '+msg);render();}catch(e){if(e?.code!=='STALE_WORKSPACE')alert('Importazione non riuscita:\n'+(e?.message||e));}});

async function openAdminFromLocation(){if(new URL(location.href).searchParams.get('admin')==='1'){if(localAdminMonitorAllowed()){route={name:'admin',courseId:null};session=null;return true;}location.replace('./admin.html#cloud');return true;}

 if(new URL(location.href).searchParams.get('admin')!=='1'||!cloudState.user||!accessState.isAdmin||accessState.status!=='active'||!featuresAllowed())return false;
 if(route.name==='admin'&&adminData.loaded)return true;
 const op=captureOperation();
 try{
  const loaded=await refreshAdminData();requireAdminOperation(op);
  if(!loaded)return false;
  route={name:'admin',courseId:null};session=null;return true;
 }catch(error){
  if(operationCurrent(op)&&accessState.isAdmin)toast('Dashboard Admin non disponibile: '+(error?.message||error));
  return false;
 }
}
let foregroundRefresh=null,lastForegroundKey=null,lastForegroundAt=0;
function refreshForeground(){
 if(document.visibilityState!=='visible')return Promise.resolve();
 const key=workspaceGeneration+':'+(cloudState.user?.id||'guest');
 if(foregroundRefresh?.key===key)return foregroundRefresh.promise;
 if(lastForegroundKey===key&&Date.now()-lastForegroundAt<1000)return Promise.resolve();
 lastForegroundKey=key;lastForegroundAt=Date.now();
 const request={key,promise:null},op=captureOperation();
 request.promise=(async()=>{
  const before=accessState.status,gate=await refreshAccessGate({renderBlocked:false});
  if(!operationCurrent(op))return;
  if(gate.status==='active'&&cloudState.user)await cloudSync({silent:true});
  if(!operationCurrent(op))return;
  if(accessState.isAdmin)await refreshAdminPending();
  if(!operationCurrent(op))return;
  if(before!==gate.status)render();else refreshSyncBadge();
 })().catch(error=>console.warn('Aggiornamento al ritorno in primo piano',error)).finally(()=>{if(foregroundRefresh===request)foregroundRefresh=null;});
 foregroundRefresh=request;return request.promise;
}
async function init(){store=await loadStore();if(!store.courses||typeof store.courses!=='object')store=emptyStore();for(const [id,c] of Object.entries(store.courses))store.courses[id]=shape(c);await applyDefaultCloudConfig();await startCloud();if(!cloudState.user&&sync.configured(store.settings||{}))route.name='home';await openAdminFromLocation();window.addEventListener('online',async()=>{const gate=await refreshAccessGate({renderBlocked:false});if(gate.status==='active')await cloudSync({silent:true});else render();});window.addEventListener('focus',refreshForeground);document.addEventListener('visibilitychange',refreshForeground);setInterval(()=>{if(document.visibilityState==='visible'&&cloudState.user&&accessState.status==='active')cloudSync({silent:true});},120000);render();if('serviceWorker'in navigator)try{
 const restored=restoreUpdateCheckpoint({accountId:cloudState.user?.id||null,courses:store.courses});if(restored&&featuresAllowed()){route=restored.route;session=restored.session;startExamTimer();render();}
 await installUpdates({version:APP_VERSION,checkpoint:async()=>{await saveStore(store);return {accountId:cloudState.user?.id||null,route,session:sessionForCheckpoint()};}});
}catch(e){console.warn(e);}studyRefreshBackground().catch(()=>{});openStudyFromLocation().catch(()=>{});}
init().catch(e=>{app.innerHTML='<main class="main"><section class="card"><h2>Errore avvio</h2><p>'+esc(e?.message||e)+'</p></section></main>';});










