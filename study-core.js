/* Shared derived metrics. Does not mutate bank/progress or change QuizLab grading. */
(function(root){
 'use strict';
 const dayMs=86400000;
 const defaults=()=>({pushEnabled:false,showPushContent:false,categories:{study:true,progress:true,service:true,marketing:false},marketingConsent:false,
  reminderTime:'19:00',quietStart:'22:00',quietEnd:'08:00',timeZone:'Europe/Rome',studyDays:[1,2,3,4,5,6,0],inactivityDays:3,countdowns:true,courseIds:[]});
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
 function deliveryWindow(p,now,{automatic=true,urgent=false}={}){
  const x=localParts(now,p.timeZone),a=minutes(p.quietStart),b=minutes(p.quietEnd);
  if(a!==b&&(a<b?x.minute>=a&&x.minute<b:x.minute>=a||x.minute<b))return false;
  if(automatic&&!urgent&&(!p.studyDays.includes(x.weekday)||x.minute<minutes(p.reminderTime)))return false;
  return true;
 }
 const validDate=v=>!!v&&Number.isFinite(Date.parse(v));
 function summarize(rows,now=new Date(),zone='Europe/Rome'){
  const today=localParts(now,zone).day,courses=[],studyDates=new Set();let lastStudyAt=null;
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
    return{questionId:q.id,unresolved,wrong,periodic:!!last&&!unresolved&&last.correct&&elapsed>=interval,priority:(unresolved?1000:0)+Math.min(wrong,20)*30+Math.min(30,Math.floor(elapsed)),nextReviewAt:last?new Date(Date.parse(last.at)+interval*dayMs).toISOString():null};
   }).filter(q=>q.unresolved||q.periodic).sort((a,b)=>b.priority-a.priority||String(a.questionId).localeCompare(String(b.questionId)));
   courses.push({courseId:row.course_id,subject:row.subject,total:ids.size,official:officialIds.size,unique:seen.size,officialUnique:[...seen].filter(id=>officialIds.has(id)).length,
    attempts,attemptCount:attempts.length,correct,accuracy:attempts.length?correct/attempts.length*100:null,exams,avg5:average(last5),previousAvg5:average(previous5),averageImprovement:previous5.length?average(last5)-average(previous5):null,
    pending:[...new Set(pending)],review,recoveredAll:!pending.length&&[...histories.values()].some(h=>h.some(a=>!a.correct))&&[...histories.values()].every(h=>!h.some(a=>!a.correct)||h.at(-1)?.correct===true),coverage:ids.size?seen.size/ids.size*100:0});
  }
  let streak=0,day=dayNumber(today);if(!studyDates.has(today))day--;while(studyDates.has(new Date(day*dayMs).toISOString().slice(0,10))){streak++;day--;}
  return {courses,lastStudyAt,streak,today,studyDates:[...studyDates].sort(),computedAt:now.toISOString()};
 }
 function periodBounds(goal,now,zone){
  const today=localParts(now,zone).day;let start=goal.startDate||today,end=goal.deadline||'9999-12-31',periodKey=goal.startDate||'all';
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
 const core={defaults,pushPresentation,localParts,deliveryWindow,summarize,goalValue,examDays,dayNumber};
 root.QuizLabStudyCore=core;if(typeof module!=='undefined'&&module.exports)module.exports=core;
})(typeof globalThis==='undefined'?this:globalThis);
