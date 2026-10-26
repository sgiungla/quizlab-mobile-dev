import './webapp/study-core.js';
import {campaignVariables} from './webapp/campaign-template-fields.js';
const core=globalThis.QuizLabStudyCore;

// Resolve only recorded, account-owned data. Do not fabricate a missing value
// or silently select an arbitrary goal/exam/badge among several candidates.
export function resolveCampaignTemplate({data,user,snapshot:s,preferences:p,items=[],badges=[],now}){
 const used=campaignVariables(data.title,data.message),needs=k=>used.includes(k),refs=data.references?.[user.id]||{};
 const values={nome_utente:user.display_name||'studente'},issues=[],context={};
 const today=core.localParts(now,p.timeZone).day;
 const issue=(variables,code,message)=>issues.push({variables,code,message});
 const pick=(list,key,selected,vars,label)=>{
  const item=selected?list.find(i=>i[key]===selected):list.length===1?list[0]:null;
  if(!item)issue(vars,selected?'reference_unavailable':list.length?'reference_ambiguous':'reference_missing',selected?`${label}: il riferimento scelto non è più disponibile o non appartiene al destinatario.`:list.length?`${label}: ci sono ${list.length} riferimenti compatibili. Scegli quale usare per questo destinatario.`:`${label}: nessun riferimento compatibile registrato. Aggiungilo nell’account dello studente, oppure rimuovi la variabile.`);
  return item;
 };
 const courseId=refs.courseId||data.filters?.courseId||null;
 const relevant=i=>!courseId||!i.data.courseId||i.data.courseId===courseId;
 let goal=null,exam=null,c=null;
 if(needs('obiettivo')||needs('giorni_obiettivo')){
  const vars=used.filter(k=>['obiettivo','giorni_obiettivo'].includes(k));
  let candidates=items.filter(i=>i.kind==='goal'&&relevant(i));
  if(needs('giorni_obiettivo')&&!refs.goalId&&candidates.length>1)candidates=candidates.filter(i=>i.data.deadline&&!['paused','expired','achieved'].includes(core.goalValue(i.data,s,now,p.timeZone).status));
  goal=pick(candidates,'item_id',refs.goalId,vars,'Obiettivo');
  if(goal){
   context.goalId=goal.item_id;context.goalRevision=Number(goal.revision);
   values.obiettivo=goal.data.title;
   if(goal.data.courseId&&!s.courses.some(c=>c.courseId===goal.data.courseId))issue(vars,'course_unavailable','La materia dell’obiettivo non è disponibile nel destinatario.');
   if(needs('giorni_obiettivo')){
    const status=core.goalValue(goal.data,s,now,p.timeZone).status;
    if(!goal.data.deadline)issue(['giorni_obiettivo'],'deadline_missing','L’obiettivo selezionato non ha una scadenza. Impostala nell’account dello studente.');
    else if(['paused','expired','achieved'].includes(status))issue(['giorni_obiettivo'],'goal_not_pending','Il countdown non è pertinente: l’obiettivo è sospeso, trascorso o già raggiunto.');
    else values.giorni_obiettivo=core.dayNumber(goal.data.deadline)-core.dayNumber(today);
   }
  }
 }
 if(needs('giorni_esame')){
  const upcoming=items.filter(i=>i.kind==='exam'&&relevant(i)&&!i.data.cancelled&&core.examDays(i.data,now,p.timeZone)>=0);
  exam=pick(upcoming,'item_id',refs.examId,['giorni_esame'],'Esame');
  if(exam){context.examId=exam.item_id;context.examRevision=Number(exam.revision);values.giorni_esame=core.examDays(exam.data,now,p.timeZone);if(!s.courses.some(c=>c.courseId===exam.data.courseId))issue(['giorni_esame'],'course_unavailable','La materia dell’esame non è disponibile nel destinatario.');}
 }
 if(needs('traguardo')){
  const badge=pick(badges,'badge_key',refs.badgeKey,['traguardo'],'Traguardo');
  if(badge){context.badgeKey=badge.badge_key;values.traguardo=badge.label;}
 }
 const related=[goal?.data.courseId,exam?.data.courseId].filter(Boolean),different=new Set([courseId,...related].filter(Boolean));
 if(different.size>1)issue(used.filter(k=>k!=='nome_utente'),'course_mismatch','Materia, obiettivo ed esame fanno riferimento a materie diverse. Scegli riferimenti coerenti.');
 const effectiveCourse=courseId||related[0];
 const quantitative=used.filter(k=>['domande_rimanenti','domande_da_ripassare','percentuale_completamento','giorni_inattivita'].includes(k));
 if(effectiveCourse&&(needs('nome_materia')||quantitative.length||related.length)){
  c=s.courses.find(c=>c.courseId===effectiveCourse);
  if(!c)issue(used.filter(k=>k!=='nome_utente'),'course_unavailable','La materia scelta non è disponibile nel destinatario.');
 }else if(needs('nome_materia'))c=pick(s.courses,'courseId',null,['nome_materia'],'Materia');
 if(c){context.courseId=c.courseId;values.nome_materia=c.subject;}
 if(quantitative.length){
  if(!s.fresh)issue(quantitative,'sync_unverified','I progressi non sono verificabili: sincronizza QuizLab sui dispositivi del destinatario e ripeti l’anteprima. Devono risultare aggiornati e senza modifiche pendenti negli ultimi 2 minuti.');
  else{
   const courses=c?[c]:s.courses,total=courses.reduce((n,c)=>n+c.total,0),unique=courses.reduce((n,c)=>n+c.unique,0);
   const bankVars=quantitative.filter(k=>k!=='giorni_inattivita');
   if(bankVars.length&&!total)issue(bankVars,'bank_missing','Non ci sono domande nella banca di riferimento. Importa o assegna una materia con domande.');
   else if(bankVars.length){values.domande_rimanenti=total-unique;values.domande_da_ripassare=courses.reduce((n,c)=>n+c.review.length,0);values.percentuale_completamento=Math.round(unique/total*100);}
   if(needs('giorni_inattivita')){
    if(!s.lastStudyAt)issue(['giorni_inattivita'],'study_activity_missing','Non risulta ancora un’attività significativa di studio. L’accesso all’app non conta come esercizio.');
    else values.giorni_inattivita=core.dayNumber(today)-core.dayNumber(core.localParts(new Date(s.lastStudyAt),p.timeZone).day);
   }
  }
 }
 const explained=new Set(issues.flatMap(i=>i.variables));
 for(const key of used)if(values[key]===undefined&&!explained.has(key))issue([key],'value_missing','Manca un dato verificabile per {'+key+'}.');
 if(issues.length)return{issues,context};
 const render=t=>t.replace(/\{([a-z_]+)\}/g,(_,key)=>String(values[key]));
 return{issues:[],context,values:Object.fromEntries(used.map(key=>[key,values[key]])),title:render(data.title),message:render(data.message)};
}
