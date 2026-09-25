import {loadStore,saveStore,emptyStore} from './db.js';
import {QuizLabSyncAdapter} from './sync-adapter.js';

const BANK_SCHEMA='unisgiunglalab.quizlab.bank';
const BACKUP_SCHEMA='unisgiunglalab.quizlab.backup';
const sync=new QuizLabSyncAdapter();
const app=document.getElementById('app');
const picker=document.getElementById('filePicker');
let store=emptyStore();
let route={name:'home',courseId:null};
let session=null;
let toastTimer=null;
let examTimer=null;
let cloudState={status:'local-only',user:null};
let autoSyncTimer=null;
let syncInFlight=false;
let lastSyncError=false;

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s??'').replace(/\s+/g,' ').trim();
const now=()=>new Date().toISOString();
const uniq=a=>[...new Set((a||[]).filter(Boolean))];
const shuffle=a=>{const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;};
const qbank=c=>[...(c?.officialBank||[]),...(c?.aiBank||[])];
const clamp=(n,a,b)=>Math.min(b,Math.max(a,Number(n)||0));
const gradeFromRatio=(correct,total)=>total?Math.round((correct/total)*300)/10:0;
const fmtGrade=v=>Number.isFinite(Number(v))?(Number.isInteger(clamp(v,0,30))?clamp(v,0,30)+'/30':clamp(v,0,30).toFixed(1).replace('.',',')+'/30'):'—';
const fmtDuration=ms=>{const t=Math.max(0,Math.floor((Number(ms)||0)/1000)),m=Math.floor(t/60),sec=t%60;return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');};
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
function syncBadgeModel(){
 const dirty=(store.sync?.dirtyCourseIds||[]).length;
 if(!cloudState.user)return {cls:'local',icon:'◇',label:'Solo locale',title:'Cloud non collegato'};
 if(!navigator.onLine)return {cls:'offline',icon:'◌',label:dirty?('Offline · '+dirty+' in attesa'):'Offline',title:'App offline: i dati restano salvati sul dispositivo'};
 if(syncInFlight)return {cls:'working',icon:'↻',label:'Sincronizzo…',title:'Sincronizzazione cloud in corso'};
 if(lastSyncError)return {cls:'error',icon:'!',label:'Sync da verificare',title:'Ultima sincronizzazione non riuscita: tocca per riprovare'};
 if(dirty)return {cls:'pending',icon:'↑',label:dirty+' da sincronizzare',title:'Modifiche locali in attesa di sincronizzazione automatica'};
 const when=fmtSyncAgo(store.sync?.lastPullAt||store.sync?.lastPushAt);
 return {cls:'ok',icon:'✓',label:'Sincronizzato'+(when?' · '+when:''),title:'Dati allineati con il cloud'};
}
function syncBadgeHtml(){
 const m=syncBadgeModel();
 return '<button class="cloud-badge '+m.cls+'" data-action="cloud" data-sync-badge title="'+esc(m.title)+'"><span class="cloud-badge-icon">'+esc(m.icon)+'</span><span>'+esc(m.label)+'</span></button>';
}
function refreshSyncBadge(){
 const el=document.querySelector('[data-sync-badge]');
 if(!el)return;
 const m=syncBadgeModel();
 el.className='cloud-badge '+m.cls;
 el.title=m.title;
 el.innerHTML='<span class="cloud-badge-icon">'+esc(m.icon)+'</span><span>'+esc(m.label)+'</span>';
}


function emptyCourse(subject=''){return {subject:norm(subject),officialBank:[],aiBank:[],topicMap:null,aiWorkflow:{},attempts:[],exams:[],marked:[],pendingReview:[],historicalWrong:[],fullCampaign:{signature:'all',seenIds:[],resetAt:null},createdAt:now(),updatedAt:now()};}
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
 return x;
}
function course(id=route.courseId){return id&&store.courses[id]?shape(store.courses[id]):null;}
async function saveCourse(id,c,{bankDirty=false}={}){
 c.updatedAt=now();store.courses[id]=c;
 store.sync=store.sync||{};
 store.sync.dirtyCourseIds=uniq([...(store.sync.dirtyCourseIds||[]),id]);
 if(bankDirty)store.sync.dirtyBankCourseIds=uniq([...(store.sync.dirtyBankCourseIds||[]),id]);
 store.sync.lastLocalChangeAt=now();
 const saved=await saveStore(store);
 refreshSyncBadge();
 scheduleAutoSync();
 return saved;
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


function top(title,sub,back){return '<header class="topbar"><div class="topbar-row">'+(back?'<button class="icon-btn" data-action="back">←</button>':'')+'<div class="brand">'+esc(title)+'<small>'+esc(sub||'')+'</small></div><div class="spacer"></div><button class="profile-chip" data-action="profile">'+avatarHtml('tiny')+'<span>'+(store.profile?.displayName?esc(store.profile.displayName.split(' ')[0]):'Profilo')+'</span></button>'+syncBadgeHtml()+'</div></header>';}
function page(body,title='QuizLab Mobile DEV',sub='offline-first',back=false){app.innerHTML='<div>'+top(title,sub,back)+'<main class="main">'+body+'</main></div>';}
function setRoute(name,courseId=route.courseId){if(examTimer){clearInterval(examTimer);examTimer=null;}route={name,courseId};session=null;render();}

function home(){
 const rows=Object.entries(store.courses||{}).map(([id,c])=>[id,shape(c)]).filter(([,c])=>qbank(c).length||c.attempts.length).sort((a,b)=>a[1].subject.localeCompare(b[1].subject));
 const p=store.profile||{};
 let html='<div class="stack"><section class="card hero jungle-hero"><div class="profile-hero">'+avatarHtml('large')+'<div><div class="eyebrow">QuizLab · Sgiungla Edition</div><h1>'+(p.displayName?'Ciao, '+esc(p.displayName.split(' ')[0])+' 👋':'Benvenuto nella Sgiungla 🌴')+'</h1><p class="jungle-line">'+esc(p.motto||'La giungla universitaria è sotto controllo.')+'</p></div></div><div class="actions"><button class="btn" data-action="import">📥 Importa materia / backup</button><button class="btn secondary" data-action="backup" '+(rows.length?'':'disabled')+'>💾 Backup mobile</button><button class="btn ghost" data-action="profile">👤 Profilo</button></div></section>';
 if(!rows.length)html+='<section class="card empty"><strong>Nessuna materia.</strong><p>Importa il JSON “banca COMPLETA” esportato dal desktop.</p></section>';
 for(const [id,c] of rows){const m=metrics(c);html+='<section class="card"><div class="eyebrow">Materia</div><div class="subject-name">'+esc(c.subject||id)+'</div><div class="bank-total"><span>Domande in banca</span><strong>'+m.total+'</strong></div><div class="pill-row"><span class="pill off">'+m.official+' ufficiali</span><span class="pill ai">'+m.ai+' AI</span><span class="pill">'+m.attempted+' affrontate</span></div><div class="stats"><div class="stat"><span>Copertura</span><strong>'+pct(m.coverage)+'</strong></div><div class="stat"><span>Accuratezza</span><strong>'+pct(m.accuracy)+'</strong></div></div><div class="actions"><button class="btn" data-action="open" data-id="'+esc(id)+'">Apri</button><button class="btn secondary" data-action="export" data-id="'+esc(id)+'">Esporta</button></div></section>';}
 html+='<section class="card"><h3 class="section-title">Sincronizzazione</h3><p class="subtle">'+(cloudState.user?'Cloud collegato · sincronizzazione automatica attiva. I progressi restano disponibili anche offline.':'Questa DEV continua a funzionare in locale; puoi collegare il cloud dal pulsante in alto.')+'</p></section></div>';
 page(html);
}

function dashboard(){
 const c=course();if(!c)return setRoute('home',null);const m=metrics(c),seen=new Set(c.fullCampaign?.seenIds||[]),remain=Math.max(0,m.total-seen.size),fullPct=m.total?seen.size/m.total:0;
 const byCh=new Map(m.chapterRows.map(r=>[r.chapter,r])),chapters=uniq(qbank(c).map(q=>Number(q.chapter)).filter(Boolean)).sort((a,b)=>a-b);
 const chapterRowsUi=chapters.map(ch=>{const r=byCh.get(ch),avail=qbank(c).filter(q=>Number(q.chapter)===ch).length,seenN=r?.total||0;let grade='—',dot='⚪',note='nessun dato',level='empty';if(seenN){if(seenN<Math.min(5,avail)){note='in analisi';level='analysis';}else{grade=fmtGrade(r.grade);dot=r.grade>=27?'🟢':r.grade>=24?'🟡':r.grade>=18?'🟠':'🔴';level=r.grade>=27?'strong':r.grade>=24?'ok':r.grade>=18?'weak':'critical';note=seenN<(avail<=12?avail:Math.max(5,Math.ceil(avail*0.6)))?'voto provvisorio':'voto consolidato';}}return {ch,avail,seenN,grade,dot,note,level};});
 const chapterHtml=chapterRowsUi.map(x=>'<div class="result chapter-row '+x.level+'"><div><div class="result-title">Cap. '+x.ch+' · '+x.dot+' '+x.grade+'</div><div class="result-meta">'+x.seenN+'/'+x.avail+' viste · '+x.note+'</div><span class="chapter-badge">'+chapterBadge(x)+'</span></div><button class="btn ghost compact-btn" data-action="train-chapter" data-chapter="'+x.ch+'">Allenati</button></div>').join('');
 const weakList=chapterRowsUi.filter(x=>['weak','critical'].includes(x.level)).sort((a,b)=>(byCh.get(a.ch)?.grade??99)-(byCh.get(b.ch)?.grade??99)).slice(0,5);
 const weakChapters=chapterRowsUi.filter(x=>['weak','critical'].includes(x.level)).length,unseenChapters=chapterRowsUi.filter(x=>x.seenN===0).length;
 const weakHtml=weakList.length?weakList.map(x=>'<button class="focus-chip" data-action="train-chapter" data-chapter="'+x.ch+'"><span>Cap. '+x.ch+'</span><strong>'+x.grade+'</strong></button>').join(''):'<div class="focus-empty">Nessun capitolo critico per ora. La Sgiungla è tranquilla. 🌴</div>';
 page('<div class="stack"><section class="card hero jungle-hero"><div class="dashboard-welcome"><div><div class="eyebrow">'+esc(route.courseId)+'</div><h1>'+esc(c.subject)+'</h1><p class="jungle-line">'+esc(jungleLine(m))+'</p></div>'+avatarHtml('normal')+'</div><div class="hero-kpis"><div class="bank-total hero-total"><span>Domande in banca</span><strong>'+m.total+'</strong></div><div class="ring-pack">'+coverageRing(m)+statRing(m.accuracy*100,'rendimento',m.correct+'/'+m.attempted)+statRing(fullPct*100,'materia completa',seen.size+'/'+m.total)+'</div></div><div class="pill-row"><span class="pill off">'+m.official+' ufficiali</span><span class="pill ai">'+m.ai+' AI</span><span class="pill">'+m.attempted+' affrontate</span></div><div class="stats"><div class="stat"><span>Preparazione stimata β</span><strong>'+(m.attempted?'≈'+fmtGrade(m.preparation):'—')+'</strong><small>'+(m.attempted?(m.coverage<0.2&&!m.exams.length?'Affidabilità bassa':m.coverage<0.5||m.exams.length<2?'Affidabilità media':'Affidabilità alta'):'nessun dato')+'</small></div><div class="stat"><span>Domande uniche affrontate</span><strong>'+m.attempted+'</strong><small>su '+m.total+' in banca</small></div><div class="stat"><span>Rendimento viste</span><strong>'+(m.attempted?fmtGrade(m.masteryGrade):'—')+'</strong><small>'+(m.attempted?pct(m.accuracy):'nessun dato')+'</small></div><div class="stat"><span>Ultimo esame</span><strong>'+(m.lastExam?(m.lastExam.lode?'30L':fmtGrade(m.lastExam.grade)):'—')+'</strong><small>'+(m.lastExam?fmtDuration(m.lastExam.elapsedMs):'nessuna simulazione')+'</small></div><div class="stat"><span>Media ultime 5</span><strong>'+(m.avg5==null?'—':fmtGrade(m.avg5))+'</strong><small>'+(m.examTrend==null?'simulazioni':(m.examTrend>0?'↗ +':'↘ ')+String(m.examTrend).replace('.',',')+' vs 5 precedenti')+'</small></div><div class="stat"><span>Miglior esame</span><strong>'+(m.best==null?'—':fmtGrade(m.best))+'</strong><small>'+m.exams.length+' simulazioni</small></div><div class="stat"><span>Tentativi totali</span><strong>'+c.attempts.length+'</strong><small>'+(m.avgResponseMs?'tempo medio '+fmtDuration(m.avgResponseMs):'tempo medio —')+'</small></div><div class="stat"><span>Forma recente</span><strong>'+(m.recent20==null?'—':pct(m.recent20))+'</strong><small>ultime 20 risposte</small></div><div class="stat"><span>Percorso materia completa</span><strong>'+seen.size+'/'+m.total+'</strong><small>'+pct(fullPct)+' · '+remain+' rimanenti</small></div></div></section><section class="grid"><button class="card btn secondary" data-action="exam">🎓 Simulazione esame</button><button class="card btn secondary" data-action="training">🧠 Allenamento</button><button class="card btn secondary" data-action="review-page">⭐ Ripasso</button><button class="card btn secondary" data-action="search">🔎 Cerca banca</button></section>'+'<section class="card"><div class="section-head"><div><div class="eyebrow">Trend</div><h3 class="section-title">Ultime simulazioni</h3></div><span class="pill">'+m.exams.length+' esami</span></div>'+examBars(m)+'</section><section class="card focus-card"><div class="section-head"><div><div class="eyebrow">Radar Sgiungla</div><h3 class="section-title">Capitoli da rinforzare</h3></div><span class="pill">'+weakChapters+' totali</span></div><div class="focus-list">'+weakHtml+'</div></section>'+(m.ai?'<section class="card"><h3 class="section-title">Performance per tipo</h3><div class="stats"><div class="stat"><span>Ufficiali</span><strong>'+(m.sourceMetrics.official.grade==null?'—':fmtGrade(m.sourceMetrics.official.grade))+'</strong><small>'+m.sourceMetrics.official.total+' uniche</small></div><div class="stat"><span>Rielaborate AI</span><strong>'+(m.sourceMetrics.ai.grade==null?'—':fmtGrade(m.sourceMetrics.ai.grade))+'</strong><small>'+m.sourceMetrics.ai.total+' uniche</small></div></div></section>':'')+'<details class="card collapse-card"><summary><div><div class="eyebrow">Analisi completa</div><h3 class="section-title">Performance per capitolo</h3><div class="pill-row"><span class="pill">'+chapters.length+' capitoli</span>'+(weakChapters?'<span class="pill warn-pill">'+weakChapters+' da rinforzare</span>':'<span class="pill ok-pill">nessuna criticità</span>')+(unseenChapters?'<span class="pill">'+unseenChapters+' non visti</span>':'')+'</div></div><span class="expand-hint">Apri ▾</span></summary><div class="collapse-body">'+chapterHtml+'</div></details><section class="card"><h3 class="section-title">Gestione QuizLab</h3><div class="actions"><button class="btn secondary" data-action="export" data-id="'+esc(route.courseId)+'">Esporta materia</button><button class="btn secondary" data-action="import">Importa / Ripristina</button><button class="btn secondary" data-action="backup">Backup completo</button></div></section></div>',c.subject,'Dashboard',true);
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
async function resetCycle(){const c=course();c.fullCampaign={signature:'all',seenIds:[],resetAt:now()};await saveCourse(route.courseId,c);toast('Ciclo materia ricominciato 🌱');training();}
function startSession(questions,title,mode='training'){
 if(!questions.length){toast('Nessuna domanda disponibile');return;}
 clearTimeout(autoSyncTimer);
 session={questions:[...questions],index:0,answers:{},title,mode,startedAt:Date.now(),questionShownAt:Date.now(),feedback:null,durationMs:mode==='exam'?30*60*1000:0,finished:false};
 route.name='session';
 if(mode==='exam'){if(examTimer)clearInterval(examTimer);examTimer=setInterval(()=>{if(!session||session.mode!=='exam'){clearInterval(examTimer);examTimer=null;return;}const left=session.durationMs-(Date.now()-session.startedAt);const el=document.getElementById('examTimer');if(el)el.textContent=fmtDuration(left);if(left<=0)finishExam(true);},1000);}
 render();
}
function current(){return session?.questions?.[session.index]||null;}
function sessionView(){
 const c=course(),q=current();if(!q)return setRoute('dashboard');
 const a=session.answers[q.id]||{},feedback=!!a.confirmed,mark=(c.marked||[]).includes(q.id),isExam=session.mode==='exam',isStudy=session.mode==='study';
 let html='<div class="stack"><section class="card"><div class="toolbar"><span class="pill">'+(session.index+1)+' / '+session.questions.length+'</span><span class="pill '+(q.source==='official'?'off':'ai')+'">'+(q.source==='official'?'Ufficiale':'AI')+'</span><span class="pill">Cap. '+q.chapter+'</span><span class="pill">'+esc(q.difficulty||'medium')+'</span>'+(q.topic?'<span class="pill">'+esc(q.topic)+'</span>':'')+(isExam?'<span class="pill" id="examTimer">'+fmtDuration(session.durationMs-(Date.now()-session.startedAt))+'</span>':'')+'<button class="btn ghost" data-action="mark">'+(mark?'★ Segnata':'☆ Segna')+'</button></div><div class="progress"><span style="width:'+(((session.index+1)/session.questions.length)*100)+'%"></span></div><div class="question">'+esc(q.text)+'</div>';
 for(const o of q.options||[]){let cl='option';if(a.selected===o.letter)cl+=' selected';if(isStudy&&o.letter===q.correct)cl+=' correct';if(!isExam&&!isStudy&&feedback&&o.letter===q.correct)cl+=' correct';if(!isExam&&!isStudy&&feedback&&a.selected===o.letter&&a.selected!==q.correct)cl+=' wrong';html+='<button class="'+cl+'" data-action="answer" data-letter="'+esc(o.letter)+'" '+(((feedback&&!isExam)||(isExam&&a.confirmed)||isStudy)?'disabled':'')+'><span class="letter">'+esc(o.letter)+'</span><span>'+esc(o.text)+'</span></button>';}
 if(isStudy){html+='<div class="feedback ok"><strong>✅ Risposta corretta evidenziata</strong>'+(q.explanation?'<p>'+esc(q.explanation)+'</p>':'')+(q.reference?'<p class="muted"><strong>Fonte:</strong> '+esc(q.reference)+'</p>':'')+'</div>';}
 else if(!isExam&&feedback){html+='<div class="feedback '+(a.correct?'ok':'bad')+'"><strong>'+(a.correct?'✓ Corretta':'✕ Errata · corretta '+esc(q.correct))+'</strong>'+(q.explanation?'<p>'+esc(q.explanation)+'</p>':'')+(q.reference?'<p class="muted"><strong>Fonte:</strong> '+esc(q.reference)+'</p>':'')+'</div>';}
 if(isExam){const examNextLabel=session.index===session.questions.length-1?(a.selected&&!a.confirmed?'Conferma e consegna':'Consegna'):(a.selected&&!a.confirmed?'Conferma e avanti →':'Avanti →');html+='<div class="actions"><button class="btn ghost" data-action="exam-prev" '+(session.index===0?'disabled':'')+'>← Indietro</button><button class="btn" data-action="exam-next">'+examNextLabel+'</button></div><p class="subtle">'+(a.confirmed?'Risposta registrata · nessuna correzione mostrata.':'Nessuna correzione durante la prova.')+' Le prime 30 determinano il voto; la 31ª vale solo per la lode.</p>';}
 else if(isStudy){html+='<div class="actions"><button class="btn ghost" data-action="study-prev" '+(session.index===0?'disabled':'')+'>← Indietro</button><button class="btn" data-action="study-next">'+(session.index===session.questions.length-1?'Fine':'Prossima →')+'</button></div>';}
 else {html+='<div class="actions">'+(!feedback?'<button class="btn" data-action="confirm" '+(a.selected?'':'disabled')+'>Conferma</button>':'<button class="btn" data-action="next">'+(session.index===session.questions.length-1?'Risultati':'Avanti →')+'</button>')+'</div>';}
 html+='</section></div>';page(html,c.subject,session.title,true);
}

async function confirmAnswer(){
 if(session.mode==='exam'||session.mode==='study')return;
 const c=course(),q=current(),a=session.answers[q.id];if(!a?.selected)return;
 const correct=a.selected===q.correct;a.confirmed=true;a.correct=correct;a.at=now();
 const elapsedMs=Date.now()-session.questionShownAt;
 c.attempts.push({questionId:q.id,chapter:q.chapter,source:q.source,difficulty:q.difficulty,correct,answer:a.selected,at:a.at,elapsedMs,mode:session.mode});
 if(session.mode==='full'){
   c.fullCampaign=c.fullCampaign||{signature:'all',seenIds:[],resetAt:null};
   c.fullCampaign.seenIds=uniq([...(c.fullCampaign.seenIds||[]),q.id]);
 }
 if(!correct){c.pendingReview=uniq([...c.pendingReview,q.id]);c.historicalWrong=uniq([...c.historicalWrong,q.id]);}
 else if(session.mode==='review'){c.pendingReview=c.pendingReview.filter(id=>id!==q.id);}
 await saveCourse(route.courseId,c);render();
}
async function nextQuestion(){if(session.index<session.questions.length-1){session.index++;session.questionShownAt=Date.now();render();}else{await cloudSync({silent:true});route.name='results';render();}}
async function confirmExamAnswer(){
 if(!session||session.mode!=='exam')return;
 const c=course(),q=current(),a=session.answers[q.id];if(!a?.selected||a.confirmed)return;
 const correct=a.selected===q.correct;a.confirmed=true;a.correct=correct;a.at=now();
 const elapsedMs=Date.now()-session.questionShownAt;
 c.attempts.push({questionId:q.id,chapter:q.chapter,source:q.source,difficulty:q.difficulty,correct,answer:a.selected,at:a.at,elapsedMs,mode:'exam',isLode:session.index===30});
 if(!correct){c.pendingReview=uniq([...c.pendingReview,q.id]);c.historicalWrong=uniq([...c.historicalWrong,q.id]);}
 await saveCourse(route.courseId,c);
}
async function finishExam(timeout=false){
 if(!session||session.mode!=='exam'||session.finished)return;
 session.finished=true;if(examTimer){clearInterval(examTimer);examTimer=null;}
 const c=course();let correct=0,lodeCorrect=false;const wrong=[];
 session.questions.forEach((q,i)=>{const a=session.answers[q.id],ok=!!a?.selected&&a.selected===q.correct,isLode=i===30;if(!isLode&&ok)correct++;if(isLode)lodeCorrect=ok;if(!ok)wrong.push(q.id);});
 const grade=correct,lode=correct===30&&lodeCorrect,elapsedMs=Date.now()-session.startedAt;
 c.exams.push({at:now(),grade,lode,correct30:correct,lodeCorrect,elapsedMs,timeout,wrongIds:wrong,questionIds:session.questions.map(q=>q.id),answeredCount:Object.values(session.answers).filter(a=>a?.selected).length});
 await saveCourse(route.courseId,c);session.examResult={grade,lode,correct,elapsedMs,wrong};await cloudSync({silent:true});route.name='results';render();
}
function results(){if(session?.mode==='exam'){const r=session.examResult;if(!r)return;page('<section class="card hero"><div class="eyebrow">🎓 Esito simulazione</div><h1>'+(r.lode?'30 e lode':r.grade+'/30')+'</h1><p>'+r.correct+'/30 corrette · '+fmtDuration(r.elapsedMs)+'</p><div class="actions"><button class="btn" data-action="dashboard">Dashboard</button><button class="btn secondary" data-action="retry-wrong">Ripassa gli errori</button></div></section>',course().subject,'Risultati',true);return;}const done=Object.entries(session.answers).filter(([,a])=>a.confirmed),ok=done.filter(([,a])=>a.correct).length,total=done.length;page('<section class="card hero"><div class="eyebrow">Sessione completata</div><h1>'+fmtGrade(gradeFromRatio(ok,total))+'</h1><p>'+ok+' / '+total+' · '+pct(total?ok/total:0)+' corrette</p><div class="actions"><button class="btn" data-action="dashboard">Torna alla materia</button><button class="btn secondary" data-action="retry-wrong">Ripassa gli errori</button></div></section>',course().subject,'Risultati',true);}

function review(kind){const c=course(),by=new Map(qbank(c).map(q=>[q.id,q]));let ids=[],title='Ripasso';if(kind==='marked'){ids=c.marked;title='Segnate da me';}else if(kind==='historical'){ids=c.historicalWrong;title='Tutti gli errori storici';}else {ids=c.pendingReview;title='Errori da recuperare';}const qs=uniq(ids).map(id=>by.get(id)).filter(Boolean);startSession(qs,title,'review');}
function reviewPage(){const c=course();page('<div class="stack"><section class="card hero"><div class="eyebrow">Ripasso mirato</div><h1>Errori e domande segnate</h1></section><section class="grid"><div class="card"><h3>❌ Tutti gli errori storici</h3><p class="subtle">'+c.historicalWrong.length+' domande sbagliate almeno una volta. Questo elenco non si riduce quando poi rispondi bene.</p><button class="btn" data-action="review" data-kind="historical" '+(c.historicalWrong.length?'':'disabled')+'>Rivedi tutti</button></div><div class="card"><h3>🧹 Errori da recuperare</h3><p class="subtle">'+c.pendingReview.length+' domande ancora da smaltire. Una risposta corretta in ripasso le toglie dalla coda.</p><button class="btn" data-action="review" data-kind="pending" '+(c.pendingReview.length?'':'disabled')+'>Smaltisci errori</button></div><div class="card"><h3>⭐ Segnate da me</h3><p class="subtle">'+c.marked.length+' domande salvate manualmente.</p><button class="btn secondary" data-action="review" data-kind="marked" '+(c.marked.length?'':'disabled')+'>Ripassa segnate</button></div></section></div>',c.subject,'Ripasso',true);}

function profilePage(){
 const p=store.profile||{};
 page('<div class="stack"><section class="card hero jungle-hero"><div class="profile-hero">'+avatarHtml('large')+'<div><div class="eyebrow">Identità Sgiungla</div><h1>'+(p.displayName?esc(p.displayName):'Il tuo profilo')+'</h1><p class="subtle">Questo profilo è locale e già strutturato per diventare il tuo account quando attiveremo il cloud.</p></div></div></section><section class="card"><h2 class="section-title">Profilo</h2><label>Nome<input id="profileName" maxlength="60" placeholder="Come vuoi essere chiamato" value="'+esc(p.displayName||'')+'"></label><label>Frase Sgiungla<input id="profileMotto" maxlength="120" value="'+esc(p.motto||'La giungla universitaria è sotto controllo.')+'"></label><div class="actions"><button class="btn secondary" data-action="avatar-pick">📷 Cambia foto</button><button class="btn" data-action="save-profile">Salva profilo</button></div><input id="avatarPicker" type="file" accept="image/*" hidden></section><section class="card"><h3 class="section-title">Sincronizzazione</h3><div class="sync-panel"><div><span>Identità locale</span><strong>'+esc(p.localUserId||store.sync?.ownerId||'—')+'</strong></div><div><span>Dispositivo</span><strong>'+esc(store.sync?.clientId||'—')+'</strong></div><div><span>Stato</span><strong>Pronto per il cloud · non ancora collegato</strong></div></div><p class="subtle">Quando abiliteremo gli account, banca e progressi saranno separati per utente. La stessa web app potrà quindi essere usata da te e dalla tua amica senza mescolare i dati.</p></section></div>','Profilo','Sgiungla ID',true);
 setTimeout(()=>{document.getElementById('avatarPicker')?.addEventListener('change',handleAvatar);},0);
}
async function handleAvatar(e){
 const f=e.target.files?.[0];if(!f)return;if(f.size>2.5*1024*1024){toast('Foto troppo grande: massimo 2,5 MB');return;}
 const reader=new FileReader();reader.onload=async()=>{store.profile.avatarDataUrl=String(reader.result||'');store.profile.updatedAt=now();store.sync.profileDirty=true;store.sync.lastLocalChangeAt=now();await saveStore(store);toast('Foto profilo aggiornata');profilePage();};reader.readAsDataURL(f);
}

function mergeRemoteCourses(rows=[]){
 for(const remote of rows){
  const local=shape(store.courses[remote.courseId]||emptyCourse(remote.subject||remote.courseId));
  const bank=remote.bank||{},progress=remote.progress||{};
  store.courses[remote.courseId]=shape({
    ...local,
    subject:remote.subject||local.subject,
    officialBank:Array.isArray(bank.officialBank)?bank.officialBank:local.officialBank,
    aiBank:Array.isArray(bank.aiBank)?bank.aiBank:local.aiBank,
    topicMap:bank.topicMap??local.topicMap,
    aiWorkflow:bank.aiWorkflow||local.aiWorkflow,
    attempts:Array.isArray(progress.attempts)?progress.attempts:local.attempts,
    exams:Array.isArray(progress.exams)?progress.exams:local.exams,
    marked:Array.isArray(progress.marked)?progress.marked:local.marked,
    pendingReview:Array.isArray(progress.pendingReview)?progress.pendingReview:local.pendingReview,
    historicalWrong:Array.isArray(progress.historicalWrong)?progress.historicalWrong:local.historicalWrong,
    fullCampaign:progress.fullCampaign||local.fullCampaign,
    createdAt:progress.createdAt||bank.createdAt||local.createdAt,
    updatedAt:progress.updatedAt||bank.updatedAt||remote.updatedAt||local.updatedAt
  });
 }
}
async function cloudSync({silent=true}={}){
 if(syncInFlight||!cloudState.user||!navigator.onLine)return false;
 const changeToken=store.sync?.lastLocalChangeAt||null;
 const dirtyAtStart=[...(store.sync?.dirtyCourseIds||[])];
 const bankDirtyAtStart=[...(store.sync?.dirtyBankCourseIds||[])];
 let changedDuringSync=false;
 syncInFlight=true;lastSyncError=false;refreshSyncBadge();
 try{
  const result=await sync.syncNow({
   dirtyCourseIds:[...(store.sync?.dirtyCourseIds||[])],
   dirtyBankCourseIds:[...(store.sync?.dirtyBankCourseIds||[])],
   courses:store.courses,
   clientId:store.sync?.clientId
  });
  changedDuringSync=(store.sync?.lastLocalChangeAt||null)!==changeToken;
  if(!changedDuringSync){
   mergeRemoteCourses(result.pull?.courses||[]);
   store.sync.dirtyCourseIds=(store.sync?.dirtyCourseIds||[]).filter(id=>!dirtyAtStart.includes(id));
   store.sync.dirtyBankCourseIds=(store.sync?.dirtyBankCourseIds||[]).filter(id=>!bankDirtyAtStart.includes(id));
  }
  store.sync.lastPushAt=now();
  store.sync.lastPullAt=now();
  store.sync.mode='cloud-online';
  await saveStore(store);
  lastSyncError=false;
  if(!silent)toast('Sincronizzazione completa ☁️');
  render();
  return true;
 }catch(e){
  lastSyncError=true;
  console.warn('Cloud sync',e);
  if(!silent)alert('Sincronizzazione non riuscita:\n'+(e?.message||e));
  return false;
 }finally{
  syncInFlight=false;
  refreshSyncBadge();
  if(changedDuringSync&&cloudState.user&&navigator.onLine)setTimeout(()=>cloudSync({silent:true}),120);
 }
}
function scheduleAutoSync(){
 if(!cloudState.user||!navigator.onLine)return;
 if(session&&route.name==='session')return;
 clearTimeout(autoSyncTimer);
 autoSyncTimer=setTimeout(()=>cloudSync({silent:true}),1400);
}
async function startCloud(){
 try{
  cloudState=await sync.start({
   settings:store.settings||{},
   onAuthChange:async ({session,status})=>{
    cloudState={status,user:session?.user||null};
    store.sync.mode=status;
    if(session?.user)store.sync.ownerId=session.user.id;
    await saveStore(store);
    render();
    if(session?.user)setTimeout(()=>cloudSync({silent:true}),0);
   }
  });
  if(cloudState.user){
    store.sync.ownerId=cloudState.user.id;
    await saveStore(store);
    await cloudSync({silent:true});
  }
 }catch(e){
  cloudState={status:'cloud-error',user:null};
  console.warn('Cloud init',e);
 }
}
function cloudPage(){
 const cfg=store.settings||{},user=cloudState.user;
 const configured=!!(cfg.supabaseUrl&&cfg.supabasePublishableKey);
 let body='<div class="stack"><section class="card hero jungle-hero"><div class="eyebrow">Cloud Sgiungla</div><h1>'+(user?'Account collegato ☁️':'Collega il tuo account')+'</h1><p class="subtle">'+(user?'Sei autenticato come '+esc(user.email||'utente')+'.':'Il database è pronto. Ora colleghiamo questa PWA al tuo account Supabase.')+'</p></section>';
 if(!configured){
  body+='<section class="card"><h2 class="section-title">Configurazione cloud</h2><label>Project URL<input id="cloudUrl" placeholder="https://...supabase.co"></label><label>Publishable key<input id="cloudKey" placeholder="sb_publishable_..."></label><button class="btn" data-action="save-cloud-config">Salva collegamento</button><p class="subtle">Usa solo la Publishable key. Non inserire mai Secret / service-role key.</p></section>';
 }else if(!user){
  body+='<section class="card"><h2 class="section-title">Account</h2><label>Email<input id="authEmail" type="email" autocomplete="email"></label><label>Password<input id="authPassword" type="password" autocomplete="current-password" minlength="8"></label><div class="actions"><button class="btn" data-action="sign-in">Accedi</button><button class="btn secondary" data-action="sign-up">Crea account</button></div><button class="btn ghost" data-action="reset-cloud-config">Cambia configurazione cloud</button></section>';
 }else{
  body+='<section class="card"><h2 class="section-title">Sincronizzazione</h2><div class="sync-panel"><div><span>Account</span><strong>'+esc(user.email||user.id)+'</strong></div><div><span>Stato</span><strong>'+esc(syncBadgeModel().label)+'</strong></div><div><span>Ultima sincronizzazione</span><strong>'+esc(fmtSyncAgo(store.sync?.lastPullAt||store.sync?.lastPushAt)||'non ancora completata')+'</strong></div><div><span>Dati locali da sincronizzare</span><strong>'+((store.sync?.dirtyCourseIds||[]).length)+' materie</strong></div></div><div class="actions"><button class="btn" data-action="sync-all">Sincronizza tutto</button><button class="btn secondary" data-action="push-profile">Sincronizza profilo</button><button class="btn ghost" data-action="sign-out">Esci</button></div><p class="subtle">La sincronizzazione è automatica. Il pulsante serve solo per forzarla subito manualmente.</p></section>';
 }
 body+='</div>';page(body,'Cloud','Account e sync',true);
}
function searchPage(){const c=course(),chs=uniq(qbank(c).map(q=>Number(q.chapter)).filter(Boolean)).sort((a,b)=>a-b);page('<div class="stack"><section class="card"><h2 class="section-title">Cerca nella banca</h2><label>Parola o frase<input id="searchInput" placeholder="es. media aritmetica"></label><div class="row"><label>Cerca in<select id="searchWhere"><option value="question">Domanda</option><option value="answers">Risposte</option><option value="explanation">Spiegazione</option><option value="topic">Argomento</option><option value="all">Tutto</option></select></label><label>Origine<select id="searchSource"><option value="all">Tutte</option><option value="official">Ufficiali</option><option value="ai">AI</option></select></label></div><div class="row"><label>Stato<select id="searchStatus"><option value="all">Tutte</option><option value="unseen">Mai viste</option><option value="correct">Corrette</option><option value="wrong">Sbagliate</option><option value="recovery">Da recuperare</option><option value="marked">Segnate</option><option value="historical">Errori storici</option><option value="warning">Con warning</option><option value="warning_unresolved">Warning irrisolti</option></select></label><label>Difficoltà<select id="searchDifficulty"><option value="all">Tutte</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label></div><label>Capitolo<select id="searchChapter"><option value="all">Tutti</option>'+chs.map(ch=>'<option value="'+ch+'">'+ch+'</option>').join('')+'</select></label></section><section class="card" id="searchResults"><div class="empty">Inserisci una ricerca o applica almeno un filtro.</div></section></div>',c.subject,'Esplora banca',true);setTimeout(()=>{for(const id of ['searchInput','searchWhere','searchSource','searchStatus','searchDifficulty','searchChapter']){const el=document.getElementById(id);if(el)el.addEventListener(id==='searchInput'?'input':'change',updateSearch);}},0);}
function searchMatches(){const c=course(),term=norm(document.getElementById('searchInput')?.value).toLowerCase(),where=document.getElementById('searchWhere')?.value||'question',src=document.getElementById('searchSource')?.value||'all',status=document.getElementById('searchStatus')?.value||'all',diff=document.getElementById('searchDifficulty')?.value||'all',ch=document.getElementById('searchChapter')?.value||'all',latest=latestMap(c);const active=!!term||src!=='all'||status!=='all'||diff!=='all'||ch!=='all';if(!active)return[];return qbank(c).filter(q=>{if(src!=='all'&&q.source!==src)return false;if(diff!=='all'&&q.difficulty!==diff)return false;if(ch!=='all'&&Number(q.chapter)!==Number(ch))return false;const a=latest.get(q.id);if(status==='unseen'&&a)return false;if(status==='correct'&&!a?.correct)return false;if(status==='wrong'&&(!a||a.correct))return false;if(status==='recovery'&&!c.pendingReview.includes(q.id))return false;if(status==='marked'&&!c.marked.includes(q.id))return false;if(status==='historical'&&!c.historicalWrong.includes(q.id))return false;if(status==='warning'&&!q.validationWarning)return false;if(status==='warning_unresolved'&&(!q.validationWarning||!['unresolved','source_not_found',''].includes(norm(q.warningResolution?.status).toLowerCase())))return false;if(!term)return true;const fields={question:[q.text],answers:(q.options||[]).map(o=>o.text),explanation:[q.explanation],topic:[q.topic,q.topicId,q.chapterTitle],all:[q.text,q.explanation,q.reference,q.topic,q.topicId,q.chapterTitle,...(q.options||[]).map(o=>o.text)]};return (fields[where]||fields.all).filter(Boolean).join(' ').toLowerCase().includes(term);});}
function updateSearch(){const r=searchMatches(),box=document.getElementById('searchResults');if(!box)return;const visible=r.slice(0,30);box.innerHTML='<div class="toolbar"><strong>'+r.length+' risultati · visualizzati '+visible.length+'</strong>'+(r.length?'<button class="btn secondary" data-action="study-search">Studia tutti</button><button class="btn secondary" data-action="train-search">Allenati sui risultati</button>':'')+'</div>'+visible.map(q=>'<div class="result"><div class="result-title">'+esc(q.text)+'</div><div class="result-meta">Cap. '+q.chapter+' · '+(q.source==='official'?'Ufficiale':'AI')+' · '+esc(q.difficulty||'medium')+(q.topic?' · '+esc(q.topic):'')+'</div><button class="btn ghost" data-action="open-question" data-qid="'+esc(q.id)+'">Apri</button></div>').join('');}

function normalizeQuestion(raw,source){if(!raw||typeof raw!=='object')return null;const options=(raw.options||[]).map((o,i)=>({letter:norm(o?.letter||['A','B','C','D'][i]).toUpperCase(),optionId:norm(o?.optionId||o?.id||('opt_'+(i+1))),text:norm(o?.text??o)})).filter(o=>/^[A-D]$/.test(o.letter)&&o.text);let correct=norm(raw.correct||raw.correctAnswer).toUpperCase();const coi=norm(raw.correctOptionId||raw.correct_option_id);if(coi){const m=options.find(o=>o.optionId===coi);if(m)correct=m.letter;}const chapter=Number(raw.chapter||raw.chapterNumber||0),text=norm(raw.text||raw.question);if(!raw.id||!chapter||!text||options.length!==4||!/^[A-D]$/.test(correct))return null;return {...raw,id:norm(raw.id),source,chapter,text,options,correct,correctOptionId:coi||options.find(o=>o.letter===correct)?.optionId||'',explanation:norm(raw.explanation||raw.spiegazione),reference:norm(raw.reference||raw.fonte||''),difficulty:['easy','medium','hard'].includes(String(raw.difficulty||'').toLowerCase())?String(raw.difficulty).toLowerCase():'medium'};}
function mergeById(oldRows,newRows){const m=new Map((oldRows||[]).map(q=>[q.id,q]));for(const q of newRows)m.set(q.id,{...(m.get(q.id)||{}),...q});return [...m.values()];}
async function importPack(p){if(!p||typeof p!=='object')throw new Error('JSON non valido');if(p.schema===BACKUP_SCHEMA){if(!p.store?.courses)throw new Error('Backup non valido');store=p.store;for(const [id,c] of Object.entries(store.courses))store.courses[id]=shape(c);await saveStore(store);return 'Backup ripristinato';}if(p.schema!==BANK_SCHEMA)throw new Error('Serve una Banca QuizLab COMPLETA o un Backup QuizLab.');const id=norm(p.course?.courseId),subject=norm(p.course?.subject||id);if(!id)throw new Error('Manca course.courseId');const off=(p.officialBank||[]).map(q=>normalizeQuestion(q,'official')).filter(Boolean),ai=(p.aiBank||[]).map(q=>normalizeQuestion(q,'ai')).filter(Boolean);if(!off.length&&!ai.length)throw new Error('Nessuna domanda valida');const c=shape(store.courses[id]||emptyCourse(subject));c.subject=subject;c.officialBank=mergeById(c.officialBank,off);c.aiBank=mergeById(c.aiBank,ai);if(p.topicMap)c.topicMap=p.topicMap;if(p.aiWorkflow)c.aiWorkflow={...c.aiWorkflow,...p.aiWorkflow};await saveCourse(id,c,{bankDirty:true});return subject+': '+off.length+' ufficiali · '+ai.length+' AI';}
function exportCourse(id){const c=course(id);if(!c)return;download(fileName(c.subject)+'_QuizLab_banca_COMPLETA_mobile.json',{schema:BANK_SCHEMA,version:2,exportedAt:now(),course:{courseId:id,subject:c.subject},officialBank:c.officialBank,aiBank:c.aiBank,topicMap:c.topicMap,aiWorkflow:c.aiWorkflow});}
function backup(){download('QuizLab_Mobile_BACKUP_'+new Date().toISOString().slice(0,10)+'.json',{schema:BACKUP_SCHEMA,version:1,exportedAt:now(),store});}

function render(){if(route.name==='home')home();else if(route.name==='dashboard')dashboard();else if(route.name==='training')training(route.presetChapter);else if(route.name==='session')sessionView();else if(route.name==='results')results();else if(route.name==='review')reviewPage();else if(route.name==='search')searchPage();else if(route.name==='profile')profilePage();else if(route.name==='cloud')cloudPage();else home();}

app.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
if(a==='back'){if(route.name==='dashboard')setRoute('home',null);else if(route.name==='session'){if(confirm('Uscire dalla sessione?'))setRoute('dashboard');}else setRoute('dashboard');return;}
if(a==='profile'){setRoute('profile',route.courseId);return;}
if(a==='cloud'){setRoute('cloud',route.courseId);return;}
if(a==='save-cloud-config'){
 const url=norm(document.getElementById('cloudUrl')?.value),key=norm(document.getElementById('cloudKey')?.value);
 if(!/^https:\/\/.+\.supabase\.co$/.test(url)||!key.startsWith('sb_publishable_')){toast('Controlla URL e Publishable key');return;}
 store.settings.supabaseUrl=url;store.settings.supabasePublishableKey=key;await saveStore(store);await startCloud();toast('Cloud configurato ☁️');cloudPage();return;
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
 const {error}=await sync.signIn(email,password);if(error){alert(error.message);return;}toast('Accesso effettuato ☁️');return;
}
if(a==='sign-out'){await sync.signOut();toast('Disconnesso dal cloud');return;}
if(a==='push-profile'){try{await sync.upsertProfile(store.profile);store.sync.profileDirty=false;store.sync.lastPushAt=now();await saveStore(store);toast('Profilo sincronizzato ☁️');cloudPage();}catch(e){alert(e.message||e);}return;}
if(a==='sync-all'){await cloudSync({silent:false});return;}


if(a==='avatar-pick'){document.getElementById('avatarPicker')?.click();return;}
if(a==='save-profile'){store.profile.displayName=norm(document.getElementById('profileName')?.value).slice(0,60);store.profile.motto=norm(document.getElementById('profileMotto')?.value).slice(0,120)||'La giungla universitaria è sotto controllo.';store.profile.updatedAt=now();store.sync.profileDirty=true;store.sync.lastLocalChangeAt=now();await saveStore(store);if(cloudState.user){try{await sync.upsertProfile(store.profile);store.sync.profileDirty=false;store.sync.lastPushAt=now();await saveStore(store);}catch(e){console.warn(e);}}toast('Profilo salvato 🌴');profilePage();return;}
if(a==='import'){picker.value='';picker.click();return;}if(a==='backup'){backup();return;}if(a==='open'){setRoute('dashboard',b.dataset.id);return;}if(a==='export'){exportCourse(b.dataset.id||route.courseId);return;}
if(a==='training'){setRoute('training');return;}if(a==='review-page'){setRoute('review');return;}if(a==='search'){setRoute('search');return;}if(a==='review'){review(b.dataset.kind);return;}
if(a==='train-chapter'){route.presetChapter=Number(b.dataset.chapter);route.name='training';session=null;render();return;}
if(a==='start-chapter'){const c=course(),ch=Number(document.getElementById('chapterSelect').value),src=document.getElementById('chapterSource').value,p=filterSource(qbank(c).filter(q=>Number(q.chapter)===ch),src),n=amountValue('chapterAmount',p.length);startSession(selectTraining(p,n,src),'Allenamento capitolo '+ch,'chapter');return;}
if(a==='start-range'){const c=course(),f=Number(document.getElementById('rangeFrom').value),t=Number(document.getElementById('rangeTo').value),src=document.getElementById('rangeSource').value,p=filterSource(qbank(c).filter(q=>Number(q.chapter)>=Math.min(f,t)&&Number(q.chapter)<=Math.max(f,t)),src),n=amountValue('rangeAmount',p.length);startSession(selectTraining(p,n,src),'Intervallo capitoli '+Math.min(f,t)+'–'+Math.max(f,t),'range');return;}
if(a==='start-full'){const c=course(),src=document.getElementById('fullSource').value,remain=filterSource(qbank(c),src).filter(q=>!(c.fullCampaign?.seenIds||[]).includes(q.id)),n=amountValue('fullAmount',remain.length),qs=await fullCampaignPool(c,n,src);startSession(qs,'Materia completa','full');return;}
if(a==='reset-cycle'){resetCycle();return;}
if(a==='exam'||a==='start-exam'){const c=course(),qs=selectTraining(qbank(c),31,'mixed');startSession(qs,'Simulazione esame','exam');return;}
if(a==='answer'){const q=current();if(!q)return;session.answers[q.id]={...(session.answers[q.id]||{}),selected:b.dataset.letter};render();return;}
if(a==='confirm'){await confirmAnswer();return;}if(a==='next'){await nextQuestion();return;}
if(a==='exam-prev'){if(session.index>0){session.index--;session.questionShownAt=Date.now();render();}return;}
if(a==='exam-next'){
 await confirmExamAnswer();
 if(session.index>=session.questions.length-1){await finishExam(false);}
 else{session.index++;session.questionShownAt=Date.now();render();}
 return;
}
if(a==='study-prev'){if(session.index>0){session.index--;render();}return;}if(a==='study-next'){if(session.index>=session.questions.length-1){await cloudSync({silent:true});setRoute('dashboard');}else{session.index++;render();}return;}
if(a==='mark'){const c=course(),q=current(),set=new Set(c.marked);set.has(q.id)?set.delete(q.id):set.add(q.id);c.marked=[...set];await saveCourse(route.courseId,c);render();return;}
if(a==='dashboard'){setRoute('dashboard');return;}
if(a==='retry-wrong'){const c=course(),by=new Map(qbank(c).map(q=>[q.id,q])),ids=session.mode==='exam'?(session.examResult?.wrong||[]):Object.entries(session.answers).filter(([,v])=>v.confirmed&&!v.correct).map(([id])=>id),qs=ids.map(id=>by.get(id)).filter(Boolean);startSession(qs,'Errori sessione','review');return;}
if(a==='open-question'){const q=qbank(course()).find(x=>x.id===b.dataset.qid);if(q)startSession([q],'Domanda','study');return;}
if(a==='study-search'){startSession(searchMatches(),'Studio risultati','study');return;}if(a==='train-search'){startSession(shuffle(searchMatches()),'Risultati ricerca','search');return;}
});

picker.addEventListener('change',async()=>{const f=picker.files?.[0];if(!f)return;try{const msg=await importPack(JSON.parse(await f.text()));toast('Importazione OK · '+msg);render();}catch(e){alert('Importazione non riuscita:\n'+(e?.message||e));}});

async function init(){store=await loadStore();if(!store.courses||typeof store.courses!=='object')store=emptyStore();for(const [id,c] of Object.entries(store.courses))store.courses[id]=shape(c);await startCloud();window.addEventListener('online',()=>cloudSync({silent:true}));render();if('serviceWorker'in navigator)try{await navigator.serviceWorker.register('./service-worker.js');}catch(e){console.warn(e);}}
init().catch(e=>{app.innerHTML='<main class="main"><section class="card"><h2>Errore avvio</h2><p>'+esc(e?.message||e)+'</p></section></main>';});
