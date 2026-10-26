import postgres from 'npm:postgres@3.4.5';
import webpush from 'npm:web-push@3.6.7';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {wrapDatabase,createAdapter} from './adapter.mjs';
import {createStudyModule} from './study.mjs';
import {createLocalCommerce} from './commerce.mjs';

const VERSION='0.11.28',url=Deno.env.get('SUPABASE_URL')!,service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sql=postgres(Deno.env.get('SUPABASE_DB_URL')!,{max:2,prepare:false,connect_timeout:8,idle_timeout:10,connection:{application_name:'quizlab-suite-0.11.28'}});
const metrics=new AsyncLocalStorage<{bytes:number}>();
const db=wrapDatabase(sql,n=>{const m=metrics.getStore();if(m)m.bytes+=n;});
const lab=createAdapter(db);
let modulesPromise:Promise<any>|null=null;
async function modules(){
 if(!modulesPromise)modulesPromise=(async()=>{
  let row=(await db.query('select settings from quizlab_release_private.suite_settings where singleton')).rows[0];
  if(!row){
   const keys=webpush.generateVAPIDKeys(),settings={...keys,subject:'https://sgiungla.github.io/quizlab-mobile-dev/',schedulerToken:randomBytes(32).toString('hex'),commerceSecret:randomBytes(32).toString('hex')};
   await db.query('insert into quizlab_release_private.suite_settings(singleton,settings)values(true,$1::jsonb)on conflict do nothing',[JSON.stringify(settings)]);
   row=(await db.query('select settings from quizlab_release_private.suite_settings where singleton')).rows[0];
  }
  const settings=row.settings;
  const sendPush=async(subscription:any,payload:string,options:any={})=>{
   const request=webpush.generateRequestDetails(subscription,payload,{vapidDetails:{subject:settings.subject,publicKey:settings.publicKey,privateKey:settings.privateKey},...options});
   const response=await fetch(request.endpoint,{method:request.method,headers:request.headers,body:request.body,signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)throw Object.assign(Error('Push provider error'),{statusCode:response.status});
   await response.body?.cancel();return{statusCode:response.status};
  };
  return{settings,study:createStudyModule({lab,vapid:settings,allowRealPush:true,sendPush}),commerce:createLocalCommerce({lab,secret:settings.commerceSecret})};
 })().catch(e=>{modulesPromise=null;throw e;});
 return modulesPromise;
}
function cors(req:Request){const origin=req.headers.get('origin')||'';return{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',...(/^https:\/\/(sgiungla\.github\.io|lms\.pegaso\.multiversity\.click)$/.test(origin)||/^chrome-extension:\/\/[a-p]{32}$/.test(origin)?{'Access-Control-Allow-Origin':origin}:{}),'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'GET, POST, OPTIONS'};}
async function user(req:Request){
 const token=req.headers.get('authorization');if(!/^Bearer [A-Za-z0-9_.-]{40,}$/.test(token||''))throw Object.assign(Error('Accesso richiesto'),{status:401});
 const r=await fetch(url+'/auth/v1/user',{headers:{apikey:service,Authorization:token!},signal:AbortSignal.timeout(8000)});
 if(!r.ok){await r.body?.cancel();throw Object.assign(Error(r.status===402?'Cloud temporaneamente limitato. I dati locali sono conservati.':'Accesso non verificabile'),{status:r.status===402?402:r.status===429?429:r.status>=500?503:401});}
 const value=await r.json();if(!/^[0-9a-f-]{36}$/i.test(value.id||''))throw Object.assign(Error('Accesso non verificabile'),{status:401});return value.id;
}
async function rate(id:string,route:string){
 const group=route==='study/test-push'?'test-push':route==='study/preview'?'preview':route;
 const limit=group==='test-push'?3:group==='preview'?15:90;
 const row=(await db.query("insert into quizlab_release_private.suite_limits(user_id,route,minute,n)values($1,$2,date_trunc('minute',now()),1)on conflict(user_id,route,minute)do update set n=quizlab_release_private.suite_limits.n+1 returning n",[id,group])).rows[0];
 if(row.n>limit)throw Object.assign(Error('Troppe richieste. Attendi un minuto.'),{status:429});
}
async function handle(req:Request){
 const u=new URL(req.url),route=u.pathname.replace(/^.*\/quizlab-suite\/?/,'').replace(/^\//,'');
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors(req)});
 const m={bytes:0};return metrics.run(m,async()=>{
 let status=200,data:any;
 try{
  if(route==='health'){return Response.json({version:VERSION,mode:'production',noRealCharge:true,scheduler:'minute'}, {headers:cors(req)});}
  if(!['GET','POST'].includes(req.method))throw Object.assign(Error('Metodo non consentito'),{status:405});
  if(Number(req.headers.get('content-length')||0)>65536)throw Object.assign(Error('Richiesta troppo grande'),{status:413});
  const {study,commerce,settings}=await modules();
  if(route==='tick'){
   const token=req.headers.get('X-QuizLab-Scheduler')||'',a=Buffer.from(token),b=Buffer.from(settings.schedulerToken);
   if(req.method!=='POST'||a.length!==b.length||!timingSafeEqual(a,b))throw Object.assign(Error('Accesso scheduler richiesto'),{status:401});
   data=await study.tick();
  }else{
   const publicCatalog=route==='commerce/catalog'&&req.method==='GET';
   const id=publicCatalog?null:await user(req);
   if(id)await rate(id,route);
   const raw=req.method==='POST'?await req.text():'';if(raw.length>65536)throw Object.assign(Error('Richiesta troppo grande'),{status:413});
   let input:any={};try{input=raw?JSON.parse(raw):{};}catch{throw Object.assign(Error('Richiesta non valida'),{status:400});}
   if(!input||Array.isArray(input)||typeof input!=='object')throw Object.assign(Error('Richiesta non valida'),{status:400});
   const offset=Number(u.searchParams.get('offset')||0);if(!Number.isInteger(offset)||offset<0||offset>100000)throw Object.assign(Error('Pagina non valida'),{status:400});
   const get:Record<string,()=>any>={
    'study/preferences':()=>study.prefs(id),'study/dashboard':()=>study.dashboard(id),'study/devices':()=>study.listDevices(id),
    'study/summary':()=>study.summary(id),'study/unread':async()=>({unread:(await study.inbox(id)).unread}),
    'study/inbox':()=>study.inbox(id,{offset,archived:u.searchParams.get('archived')==='true'}),
    'study/push-config':()=>study.publicConfig(),'study/campaign-options':()=>study.campaignOptions(id),'study/admin':()=>study.report(id,offset),
    'commerce/catalog':()=>commerce.catalog(),'commerce/orders':()=>commerce.orders(id,{all:u.searchParams.get('all')==='true',offset}),
    'commerce/library':()=>commerce.library(id),'commerce/products':()=>commerce.products(id),
    'admin/traffic':async()=>{if(!await lab.rpc(id,'quizlab_is_admin'))throw Object.assign(Error('Amministratore richiesto'),{status:403});return{source:'server-logical-response-bytes',estimate:true,officialEgress:false,rows:(await db.query("select day,route,requests,response_bytes,database_logical_bytes,errors,last_at from quizlab_release_private.suite_traffic where day>=current_date-31 order by day desc,route")).rows,scheduler:(await db.query('select enabled,last_run,lease_until from quizlab_release_private.suite_scheduler where singleton')).rows[0]};}
   };
   const post:Record<string,()=>any>={
    'study/preferences':()=>study.savePreferences(id,input),'study/item':()=>study.saveItem(id,input),'study/device':()=>study.registerDevice(id,input),
    'study/heartbeat':()=>study.heartbeat(id,input),'study/revoke-device':()=>study.revokeDevice(id,input),'study/mark':()=>study.mark(id,input),
    'study/receipt':()=>study.receipt(id,input),'study/diagnostics':()=>study.saveDiagnostics(id,input),'study/test-push':()=>study.testPush(id,input),
    'study/automation':()=>study.saveAutomation(id,input),'study/preview':()=>study.preview(id,input),'study/campaign':async()=>{const result=await study.saveCampaign(id,input);if(input.action==='confirm')await study.tick();return result;},
    'study/tick':async()=>{if(!await lab.rpc(id,'quizlab_is_admin'))throw Object.assign(Error('Amministratore richiesto'),{status:403});return study.tick();},
    'commerce/checkout':()=>commerce.createOrder(id,input),'commerce/products':()=>commerce.saveProduct(id,input),
    'commerce/simulate':()=>commerce.simulate(id,input),'commerce/review':()=>commerce.review(id,input)
   };
   const action=(req.method==='GET'?get:post)[route];if(!action)throw Object.assign(Error('Operazione non disponibile'),{status:404});data=await action();
  }
 }catch(e:any){status=e.status||(/^23/.test(e.code||'')?409:503);data={message:status<500?e.message:'Servizio temporaneamente non disponibile. I dati locali restano conservati.'};console.warn('QuizLab suite',route,status,e.code||e.name);}
 const json=JSON.stringify(data),bytes=new TextEncoder().encode(json).byteLength;
 // Aggregate sizes only: never store request bodies, tokens, endpoints or student text in traffic logs.
 if(route!=='tick'||status===200)try{await db.query("insert into quizlab_release_private.suite_traffic(day,route,requests,response_bytes,database_logical_bytes,errors)values(current_date,$1,1,$2,$3,$4)on conflict(day,route)do update set requests=suite_traffic.requests+1,response_bytes=suite_traffic.response_bytes+excluded.response_bytes,database_logical_bytes=suite_traffic.database_logical_bytes+excluded.database_logical_bytes,errors=suite_traffic.errors+excluded.errors,last_at=now()",[/^(study|commerce|admin)\/[a-z-]+$/.test(route)?route:route==='tick'?'tick':'unknown',bytes,m.bytes,status>=400?1:0]);}catch{}
 return new Response(json,{status,headers:cors(req)});
 });
}
Deno.serve(handle);
