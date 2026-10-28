// Device-observed aggregates only. These are not provider billing metrics.
import {createHash} from 'node:crypto';
const OPS=Object.freeze({startup:3000,course_open:1000,answer:700,local_save:500,cloud_sync:5000,gradebook_save:700});
const KINDS=['pwa_desktop','pwa_mobile','extension_desktop'],UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(status,message)=>Object.assign(Error(message),{status});
function validate(input,now){
 if(!UUID.test(input?.batch_id||'')||!KINDS.includes(input?.kind)||!Array.isArray(input?.rows)||!input.rows.length||input.rows.length>42)throw fail(400,'Misure non valide');
 const today=now.toISOString().slice(0,10),oldest=new Date(now.getTime()-6*86400000).toISOString().slice(0,10),keys=new Set();
 const rows=input.rows.map(r=>{
  const dayAt=Date.parse(String(r?.day)+'T00:00:00Z');
  if(!r||!Object.hasOwn(OPS,r.operation)||!/^\d{4}-\d{2}-\d{2}$/.test(r.day)||!Number.isFinite(dayAt)||new Date(dayAt).toISOString().slice(0,10)!==r.day||r.day<oldest||r.day>today)throw fail(400,'Periodo o operazione non validi');
  const key=r.day+':'+r.operation;if(keys.has(key))throw fail(400,'Misura duplicata nel gruppo');keys.add(key);
  if(!Number.isInteger(r.count)||r.count<1||r.count>1000||!Number.isInteger(r.errors)||r.errors<0||r.errors>r.count||!Number.isInteger(r.slow)||r.slow<0||r.slow>r.count||!Number.isFinite(r.totalMs)||!Number.isFinite(r.maxMs)||r.maxMs<0||r.maxMs>120000||r.totalMs<r.maxMs||r.totalMs>r.count*r.maxMs+0.1)throw fail(400,'Campione non valido');
  return {day:r.day,operation:r.operation,count:r.count,totalMs:Math.round(r.totalMs*10)/10,maxMs:Math.round(r.maxMs*10)/10,errors:r.errors,slow:r.slow};
 }).sort((a,b)=>(a.day+a.operation).localeCompare(b.day+b.operation));
 return {batch_id:input.batch_id.toLowerCase(),kind:input.kind,rows};
}
export function createPerformanceModule({lab,clock=()=>new Date()}){
 const db=lab.db;
 async function collect(user,input){
  if(!UUID.test(user||''))throw fail(401,'Accesso richiesto');
  const license=await lab.rpc(user,'quizlab_license_status');if(license?.status!=='active')throw fail(403,'Accesso non attivo');
  const value=validate(input,clock()),hash=createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return db.transaction(async tx=>{
   const inserted=await tx.query('insert into quizlab_release_private.performance_batches(user_id,batch_id,body_hash)values($1,$2,$3)on conflict do nothing returning batch_id',[user,value.batch_id,hash]);
   if(!inserted.rows.length){const old=(await tx.query('select body_hash from quizlab_release_private.performance_batches where user_id=$1 and batch_id=$2',[user,value.batch_id])).rows[0];if(old?.body_hash!==hash)throw fail(409,'Gruppo misure già registrato con contenuto diverso');return {accepted:true,duplicate:true};}
   const recent=(await tx.query("select count(*)::integer as n from quizlab_release_private.performance_batches where user_id=$1 and received_at>now()-interval '1 hour'",[user])).rows[0];
   if(Number(recent?.n)>72)throw fail(429,'Misure troppo frequenti');
   for(const r of value.rows)await tx.query('insert into quizlab_release_private.performance_daily(day,kind,operation,samples,total_ms,max_ms,errors,slow_samples)values($1,$2,$3,$4,$5,$6,$7,$8)on conflict(day,kind,operation)do update set samples=performance_daily.samples+excluded.samples,total_ms=performance_daily.total_ms+excluded.total_ms,max_ms=greatest(performance_daily.max_ms,excluded.max_ms),errors=performance_daily.errors+excluded.errors,slow_samples=performance_daily.slow_samples+excluded.slow_samples,last_at=now()',[r.day,value.kind,r.operation,r.count,r.totalMs,r.maxMs,r.errors,r.slow]);
   // Keep the tiny aggregate history bounded. Batch receipts are retained long
   // enough to cover every accepted retry (client samples expire in seven days).
   await tx.query("delete from quizlab_release_private.performance_batches where received_at<now()-interval '14 days'");
   await tx.query("delete from quizlab_release_private.performance_daily where day<current_date-35");
   return {accepted:true,duplicate:false};
  });
 }
 async function report(user,{days=7}={}){
  if(!await lab.rpc(user,'quizlab_is_admin'))throw fail(403,'Amministratore richiesto');
  if(![7,31].includes(Number(days)))throw fail(400,'Periodo non valido');days=Number(days);
  const groups=(await db.query('select kind,operation,sum(samples)::bigint as samples,sum(total_ms)::double precision as total_ms,max(max_ms)::double precision as max_ms,sum(errors)::bigint as errors,sum(slow_samples)::bigint as slow_samples,max(last_at) as last_at from quizlab_release_private.performance_daily where day>=current_date-($1::integer-1)group by kind,operation order by kind,operation',[days])).rows;
  const daily=(await db.query('select day,sum(samples)::bigint as samples,sum(total_ms)::double precision as total_ms,sum(errors)::bigint as errors,sum(slow_samples)::bigint as slow_samples from quizlab_release_private.performance_daily where day>=current_date-($1::integer-1)group by day order by day',[days])).rows;
  return {source:'device-observed-aggregates',officialEgress:false,estimated:false,clientReported:true,days,observedAt:clock().toISOString(),sampleCapPerDeviceOperationDay:1000,
   rows:groups.map(r=>({...r,samples:Number(r.samples),total_ms:Number(r.total_ms),max_ms:Number(r.max_ms),errors:Number(r.errors),slow_samples:Number(r.slow_samples),average_ms:Number(r.samples)?Number(r.total_ms)/Number(r.samples):null,slow_threshold_ms:OPS[r.operation]})),daily:daily.map(r=>({...r,samples:Number(r.samples),total_ms:Number(r.total_ms),errors:Number(r.errors),slow_samples:Number(r.slow_samples)}))};
 }
 return {collect,report};
}
export const performanceContract=Object.freeze({operations:OPS,kinds:KINDS,validate});
