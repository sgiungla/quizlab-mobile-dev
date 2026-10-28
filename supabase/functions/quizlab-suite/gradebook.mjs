// Real university results share the existing exam/calendar records. Quiz
// simulation grades and question banks are never written by this module.
import {createHash} from 'node:crypto';
import './webapp/study-core.js';
const core=globalThis.QuizLabStudyCore;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=v=>{if(typeof v!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))throw fail(400,'Identificativo del libretto non valido');return v.toLowerCase();};
const text=(v,max=160)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\u0000-\u001f]/.test(v))throw fail(400,'Testo del libretto non valido');return v.trim();};
const number=(v,min,max)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw fail(400,'Valore del libretto fuori intervallo');return v;};
const day=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw fail(400,'Data dell’esame non valida');return v;};
export const GRADEBOOK_DEFAULTS=Object.freeze({degreeName:'',totalCredits:180,honorsValue:30,thesisBonus:0});
export function validateGradebookSettings(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw fail(400,'Impostazioni del percorso non valide');
 return {degreeName:raw.degreeName===''?'':text(raw.degreeName),totalCredits:number(raw.totalCredits,1,1000),honorsValue:number(raw.honorsValue,30,33),thesisBonus:number(raw.thesisBonus,0,30)};
}
export function validateGradebookExam(raw,{existing=null,allowMissingCredits=false,today=new Date().toISOString().slice(0,10)}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!['planned','passed'].includes(raw.status))throw fail(400,'Esame non valido');
 const credits=raw.credits===null&&(existing?.credits===null||allowMissingCredits)?null:number(raw.credits,0.01,1000);
 const grade=raw.status==='passed'&&!raw.passFail?number(raw.grade,18,30):null;
 if(grade!==null&&!Number.isInteger(grade))throw fail(400,'Il voto deve essere un intero da 18 a 30');
 if(raw.honors&&(grade!==30||raw.passFail))throw fail(400,'La lode richiede il voto 30');
 const plannedDate=raw.plannedDate?day(raw.plannedDate):null,passedDate=raw.status==='passed'?day(raw.passedDate):null;
 if(raw.status==='planned'&&!plannedDate)throw fail(400,'Indica la data prevista dell’esame');
 if(passedDate&&passedDate>today)throw fail(400,'Un esame superato non può avere una data futura');
 if(raw.plannedTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.plannedTime))throw fail(400,'Ora dell’esame non valida');
 return {id:uuid(raw.id),courseId:raw.courseId?text(raw.courseId,256):null,subject:text(raw.subject),credits,status:raw.status,
  plannedDate,plannedTime:raw.plannedTime||null,passedDate,grade,honors:raw.status==='passed'&&!!raw.honors,passFail:!!raw.passFail,includeInAverage:raw.passFail?false:raw.includeInAverage!==false,cancelled:raw.status==='planned'&&raw.cancelled===true};
}
export function examFromStudyItem(item){
 const d=item.data||{},b=d.gradebook||{};
 return{id:item.item_id,courseId:d.courseId||null,subject:b.subject||d.subject||'',credits:b.credits??null,status:b.status==='passed'?'passed':'planned',
  plannedDate:d.date||null,plannedTime:d.time||null,passedDate:b.passedDate||null,grade:b.grade??null,honors:!!b.honors,passFail:!!b.passFail,includeInAverage:b.passFail?false:b.includeInAverage!==false,
  revision:Number(item.revision||0),cancelled:!!d.cancelled};
}
export function gradebookData(exam,previous={}){
 return{...previous,courseId:exam.courseId,date:exam.plannedDate,time:exam.plannedTime,preparation:previous.preparation||'Prepararmi per l’esame',
  cancelled:exam.status==='passed'||exam.cancelled===true,gradebook:{subject:exam.subject,credits:exam.credits,status:exam.status,passedDate:exam.passedDate,grade:exam.grade,honors:exam.honors,passFail:exam.passFail,includeInAverage:exam.includeInAverage}};
}
export function passedCourseIds(items){return [...new Set(items.filter(i=>!i.deleted&&i.kind==='exam'&&i.data?.gradebook?.status==='passed'&&i.data.courseId).map(i=>i.data.courseId))];}
export function courseNotificationSettings(settings,items){return {...settings,pausedCourseIds:[...new Set([...(settings.pausedCourseIds||[]),...passedCourseIds(items)])]};}
const duplicateKey=exam=>JSON.stringify([exam.courseId||null,exam.subject.trim().toLocaleLowerCase('it'),exam.credits??null,exam.status,exam.plannedDate||null,exam.plannedTime||null,exam.passedDate||null,exam.grade??null,!!exam.honors,!!exam.passFail]);
// Legacy study-editor writes use the same lock as the libretto. The trigger in
// the additive migration updates the shared revision, even for old clients.
export async function lockGradebook(tx,user){await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user+':gradebook']);}

export function createGradebookModule({lab,clock=()=>new Date()}){
 const db=lab.db;
 async function requireAccess(user){uuid(user);const l=await lab.rpc(user,'quizlab_license_status');if(l.status!=='active'||l.modules?.gradebook!==true)throw fail(403,'Libretto non abilitato per questo account. I dati restano conservati.');}
 async function readTx(tx,user){
  const r=(await tx.query(`select coalesce(a.revision,0) as revision,a.settings,
   coalesce((select jsonb_agg(jsonb_build_object('item_id',i.item_id,'kind',i.kind,'revision',i.revision,'data',i.data) order by i.updated_at desc,i.item_id) from public.quizlab_study_items i where i.user_id=$1 and i.kind='exam' and not i.deleted),'[]'::jsonb) as items,
   coalesce((select jsonb_agg(jsonb_build_object('courseId',c.course_id,'subject',c.subject) order by c.subject) from (select distinct on (b.course_id) b.course_id,b.subject from public.quizlab_banks b where b.owner_id=$1 and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=b.course_id) and not exists(select 1 from public.quizlab_user_deleted_courses d where d.user_id=$1 and d.course_id=b.course_id) order by b.course_id,b.updated_at desc)c),'[]'::jsonb) as courses
   from(select $1::uuid as user_id)x left join quizlab_release_private.gradebook_accounts a using(user_id)`,[user])).rows[0];
  const courses=r.courses||[];return{revision:Number(r.revision),settings:r.settings||{...GRADEBOOK_DEFAULTS},
   exams:(r.items||[]).map(i=>{const e=examFromStudyItem(i);if(!e.subject)e.subject=courses.find(c=>c.courseId===e.courseId)?.subject||'Esame da completare';return e;}),courses};
 }
 async function read(user){await requireAccess(user);return readTx(db,user);}
 async function preferences(tx,user,{lock=false}={}){
  if(lock)await tx.query('insert into public.quizlab_notification_preferences(user_id,settings)values($1,$2::jsonb)on conflict(user_id)do nothing',[user,JSON.stringify(core.defaults())]);
  const row=(await tx.query('select settings from public.quizlab_notification_preferences where user_id=$1'+(lock?' for update':''),[user])).rows[0];return row?.settings||core.defaults();
 }
 async function courseOwned(tx,user,id,old){
  if(!id||old?.courseId===id)return;
  if(!(await tx.query('select 1 from public.quizlab_banks where owner_id=$1 and course_id=$2 limit 1',[user,id])).rows.length)throw fail(403,'La materia collegata non appartiene a questo account');
 }
 async function suppress(tx,user,courseId){
  if(!courseId)return;
  const p=await preferences(tx,user,{lock:true});
  if(!(p.pausedCourseIds||[]).includes(courseId))await tx.query(`insert into public.quizlab_notification_preferences(user_id,settings) values($1,$2::jsonb) on conflict(user_id)do update set settings=excluded.settings,revision=quizlab_notification_preferences.revision+1,updated_at=now()`,[user,JSON.stringify({...p,pausedCourseIds:[...new Set([...(p.pausedCourseIds||[]),courseId])]})]);
  await tx.query(`update public.quizlab_study_items set data=jsonb_set(jsonb_set(data,'{paused}','true'::jsonb),'{closedReason}','"exam_passed"'::jsonb),revision=revision+1,updated_at=now() where user_id=$1 and kind='goal' and not deleted and data->>'courseId'=$2 and coalesce((data->>'paused')::boolean,false)=false`,[user,courseId]);
  await tx.query(`update public.quizlab_notifications n set delivery_cancelled=true,state=case when n.state='queued' then 'cancelled' else n.state end,push_state='not_relevant',push_checked_at=$3 where n.user_id=$1 and n.state in ('queued','ready') and n.read_at is null and n.archived_at is null and (n.context->>'courseId'=$2 or exists(select 1 from public.quizlab_study_items i where i.user_id=$1 and i.item_id::text=n.context->>'itemId' and i.data->>'courseId'=$2))`,[user,courseId,clock()]);
 }
 async function restore(tx,user,id){
  if(!id)return;
  if((await tx.query(`select 1 from public.quizlab_study_items where user_id=$1 and kind='exam' and not deleted and data->>'courseId'=$2 and data->'gradebook'->>'status'='passed' limit 1`,[user,id])).rows.length)return;
  const p=await preferences(tx,user,{lock:true});await tx.query(`insert into public.quizlab_notification_preferences(user_id,settings)values($1,$2::jsonb)on conflict(user_id)do update set settings=excluded.settings,revision=quizlab_notification_preferences.revision+1,updated_at=now()`,[user,JSON.stringify({...p,pausedCourseIds:(p.pausedCourseIds||[]).filter(c=>c!==id)})]);
 }
 async function mutate(user,input){
  await requireAccess(user);if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Modifica del libretto non valida');
  const request=uuid(input.mutationId);if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw fail(400,'Revisione del libretto non valida');
  const fingerprint=hash({scope:'gradebook-v1',input});
  return db.transaction(async tx=>{
   await lockGradebook(tx,user);
   const prior=(await tx.query('select fingerprint from public.quizlab_study_requests where user_id=$1 and request_id=$2',[user,request])).rows[0];
   if(prior){if(prior.fingerprint!==fingerprint)throw fail(409,'Richiesta già usata per un’altra modifica');return{...await readTx(tx,user),replayed:true};}
   const current=await readTx(tx,user);
   if(current.revision!==input.expectedRevision)throw Object.assign(fail(409,'Libretto modificato su un altro dispositivo. Le tue modifiche locali sono conservate.'),{current});
   const p=await preferences(tx,user),today=core.localParts(clock(),p.timeZone||'Europe/Rome').day;
   const existing=(await tx.query("select item_id,user_id,kind,revision,data,deleted from public.quizlab_study_items where user_id=$1 and kind='exam'",[user])).rows;
   const save=async(raw,{importing=false}={})=>{
    const id=uuid(raw?.id),old=existing.find(i=>i.item_id===id),normalized=old?examFromStudyItem(old):null;
    if(importing&&old)throw fail(409,'Il backup contiene un esame già presente: nessun dato è stato sovrascritto');
    const exam=validateGradebookExam(raw,{existing:normalized,allowMissingCredits:importing,today});await courseOwned(tx,user,exam.courseId,normalized);
    if(exam.courseId&&existing.some(i=>i.item_id!==id&&!i.deleted&&i.data?.courseId===exam.courseId))throw fail(409,'Questa materia ha già un esame nel libretto. Modifica quello esistente.');
    if(existing.some(i=>i.item_id!==id&&!i.deleted&&duplicateKey(examFromStudyItem(i))===duplicateKey(exam)))throw fail(409,'Esame già presente nel libretto');
    const data=gradebookData(exam,old?.data);
    const row=(await tx.query(`insert into public.quizlab_study_items(item_id,user_id,kind,data,deleted)values($1,$2,'exam',$3::jsonb,false) on conflict(item_id)do update set data=excluded.data,deleted=false,revision=quizlab_study_items.revision+1,updated_at=now() where quizlab_study_items.user_id=$2 and quizlab_study_items.kind='exam' returning item_id`,[id,user,JSON.stringify(data)])).rows[0];
    if(!row)throw fail(403,'Esame non disponibile per questo account');
    const replacement={item_id:id,user_id:user,kind:'exam',data,deleted:false};if(old)Object.assign(old,replacement);else existing.push(replacement);
    await tx.query(`update public.quizlab_notifications set delivery_cancelled=true,state=case when state='queued' then 'cancelled' else state end where user_id=$1 and state in ('queued','ready') and context->>'itemId'=$2`,[user,id]);
    if(exam.status==='passed')await suppress(tx,user,exam.courseId);
    if(normalized?.status==='passed'&&(exam.status!=='passed'||normalized.courseId!==exam.courseId)){
     if(input.restoreReminders===true)await restore(tx,user,normalized.courseId);
     else await suppress(tx,user,normalized.courseId);
    }
   };
   if(input.action==='save-exam'){
    if(!existing.some(i=>i.item_id===input.exam?.id)&&existing.filter(i=>!i.deleted).length>=500)throw fail(400,'Limite di 500 esami raggiunto');
    await save(input.exam);
   }else if(input.action==='delete-exam'){
    const id=uuid(input.id),old=existing.find(i=>i.item_id===id&&!i.deleted);if(!old)throw fail(404,'Esame non trovato nel libretto');
    await tx.query("update public.quizlab_study_items set deleted=true,revision=revision+1,updated_at=now()where user_id=$1 and item_id=$2 and kind='exam'",[user,id]);
    await tx.query("update public.quizlab_notifications set delivery_cancelled=true,state=case when state='queued' then 'cancelled' else state end where user_id=$1 and state in ('queued','ready') and context->>'itemId'=$2",[user,id]);
    if(input.restoreReminders===true)await restore(tx,user,old.data.courseId);
    else if(old.data.gradebook?.status==='passed')await suppress(tx,user,old.data.courseId);
   }else if(input.action==='save-settings'){
    const settings=validateGradebookSettings(input.settings);await tx.query('insert into quizlab_release_private.gradebook_accounts(user_id,settings,revision)values($1,$2::jsonb,1)on conflict(user_id)do update set settings=excluded.settings,revision=gradebook_accounts.revision+1,updated_at=now()',[user,JSON.stringify(settings)]);
   }else if(input.action==='import'){
    if(!Array.isArray(input.exams)||input.exams.length>500||existing.filter(i=>!i.deleted).length+input.exams.length>500)throw fail(400,'Numero di esami nel backup non valido');
    if(input.settings){const settings=validateGradebookSettings(input.settings);await tx.query('insert into quizlab_release_private.gradebook_accounts(user_id,settings,revision)values($1,$2::jsonb,1)on conflict(user_id)do update set settings=excluded.settings,revision=gradebook_accounts.revision+1,updated_at=now()',[user,JSON.stringify(settings)]);}
    for(const exam of input.exams)await save(exam,{importing:true});
   }else throw fail(400,'Operazione del libretto non disponibile');
   await tx.query("insert into public.quizlab_study_requests(user_id,request_id,fingerprint,result)values($1,$2,$3,$4::jsonb)",[user,request,fingerprint,JSON.stringify({scope:'gradebook',action:input.action})]);
   await tx.query("insert into public.quizlab_notification_audit(actor_id,action,detail)values($1,'gradebook',$2::jsonb)",[user,JSON.stringify({action:input.action,request_id:request})]);
   return readTx(tx,user);
  });
 }
 return{read,mutate};
}
