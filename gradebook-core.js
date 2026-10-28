(function(root){
 'use strict';
 const FORMAT='unisgiunglalab-gradebook',MAX_EXAMS=500,controllers=new Map();
 const clone=value=>JSON.parse(JSON.stringify(value));
 const id=()=>root.crypto.randomUUID();
 const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;};
 const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
 function settings(value={}){
  const out={degreeName:String(value.degreeName||'').trim(),totalCredits:Number(value.totalCredits??180),honorsValue:Number(value.honorsValue??30),thesisBonus:Number(value.thesisBonus??0)};
  if(out.degreeName.length>160)throw Error('Il nome del percorso è troppo lungo.');
  if(!Number.isFinite(out.totalCredits)||out.totalCredits<=0||out.totalCredits>1000)throw Error('Indica un totale CFU valido, fino a 1.000.');
  if(!Number.isFinite(out.honorsValue)||out.honorsValue<30||out.honorsValue>33)throw Error('Il valore del 30 e lode deve essere tra 30 e 33.');
  if(!Number.isFinite(out.thesisBonus)||out.thesisBonus<0||out.thesisBonus>30)throw Error('Indica punti aggiuntivi tra 0 e 30.');
  return out;
 }
 function exam(value,{legacy=false}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Esame non valido.');
  const out={id:value.id||id(),courseId:value.courseId?String(value.courseId):null,subject:String(value.subject||'').trim(),credits:value.credits==null||value.credits===''?null:Number(value.credits),status:value.status||'planned',plannedDate:value.plannedDate||null,plannedTime:value.plannedTime||null,passedDate:value.passedDate||null,grade:value.grade==null||value.grade===''?null:Number(value.grade),honors:value.honors===true,passFail:value.passFail===true,includeInAverage:value.includeInAverage!==false,cancelled:value.cancelled===true};
  if(!validId(out.id))throw Error('Identificativo esame non valido.');
  if(!out.subject||out.subject.length>160)throw Error('Indica il nome della materia, fino a 160 caratteri.');
  if(out.courseId&&out.courseId.length>240)throw Error('Collegamento alla materia non valido.');
  if(out.credits===null?!legacy:!Number.isFinite(out.credits)||out.credits<=0||out.credits>1000)throw Error('Indica CFU maggiori di zero, fino a 1.000.');
  if(!['planned','passed'].includes(out.status))throw Error('Stato esame non valido.');
  if(out.plannedDate&&!date(out.plannedDate))throw Error('Data prevista non valida.');
  if(out.plannedTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.plannedTime))throw Error('Ora prevista non valida.');
  if(out.status==='planned'&&!out.plannedDate)throw Error('Indica la data prevista dell’esame.');
  if(out.status==='passed'){
   if(!date(out.passedDate)||out.passedDate>today())throw Error('Indica la data in cui hai superato l’esame, non futura.');
   if(!out.passFail&&(!Number.isInteger(out.grade)||out.grade<18||out.grade>30))throw Error('Il voto deve essere un intero da 18 a 30.');
   if(out.honors&&(out.grade!==30||out.passFail))throw Error('La lode si può associare soltanto al voto 30.');
  }else{out.grade=null;out.honors=false;out.passedDate=null;}
  if(out.passFail){out.grade=null;out.honors=false;out.includeInAverage=false;}
  return out;
 }
 function empty(){return{revision:0,settings:settings(),exams:[],courses:[]};}
 function snapshot(value){
  const source=value?.snapshot||value;if(!source||!Number.isSafeInteger(Number(source.revision))||Number(source.revision)<0||!Array.isArray(source.exams)||source.exams.length>MAX_EXAMS)throw Error('Risposta del libretto incompleta. I dati locali restano conservati.');
  const exams=source.exams.map(row=>exam(row,{legacy:true})),ids=new Set();for(const row of exams){if(ids.has(row.id))throw Error('Esami duplicati nella risposta del libretto.');ids.add(row.id);}
  return{revision:Number(source.revision),settings:settings(source.settings),exams,courses:Array.isArray(source.courses)?source.courses.filter(c=>c&&typeof c.courseId==='string'&&typeof c.subject==='string').map(c=>({courseId:c.courseId,subject:c.subject})):[]};
 }
 function calculate(value){
  const cfg=settings(value.settings),passed=(value.exams||[]).filter(e=>e.status==='passed'),credits=passed.reduce((sum,e)=>sum+(Number(e.credits)||0),0),rated=passed.filter(e=>!e.passFail&&e.includeInAverage!==false&&Number.isFinite(Number(e.grade))&&Number(e.credits)>0),ratedCredits=rated.reduce((sum,e)=>sum+Number(e.credits),0),weighted=ratedCredits?rated.reduce((sum,e)=>sum+(e.honors?cfg.honorsValue:Number(e.grade))*Number(e.credits),0)/ratedCredits:null;
  const base=weighted===null?null:weighted*110/30,projection=base===null?null:Math.min(110,base+cfg.thesisBonus),planned=(value.exams||[]).filter(e=>e.status==='planned'&&!e.cancelled&&e.plannedDate>=today()).sort((a,b)=>(a.plannedDate+(a.plannedTime||'')).localeCompare(b.plannedDate+(b.plannedTime||'')));
  return{passed:passed.length,rated: rated.length,credits,ratedCredits,totalCredits:cfg.totalCredits,percentage:Math.min(100,credits/cfg.totalCredits*100),remainingCredits:Math.max(0,cfg.totalCredits-credits),weighted,base,projection,nextExam:planned[0]||null};
 }
 function simulate(value,grade,credits,honors=false){const copy=clone(value);copy.exams.push(exam({subject:'Simulazione',credits,grade,honors,status:'passed',passedDate:today()}));return calculate(copy);}
 function apply(value,command){
  const out=clone(value);
  if(command.action==='save-settings')out.settings=settings(command.settings);
  else if(command.action==='save-exam'){const row=exam(command.exam),at=out.exams.findIndex(x=>x.id===row.id);if(row.courseId&&out.exams.some(x=>x.id!==row.id&&x.courseId===row.courseId))throw Error('Questa materia ha già un esame nel libretto. Modifica quello esistente dall’elenco.');if(at<0)out.exams.push(row);else out.exams[at]=row;}
  else if(command.action==='delete-exam')out.exams=out.exams.filter(x=>x.id!==command.id);
  else if(command.action==='import'){
   const ids=new Set(out.exams.map(x=>x.id));for(const row of command.exams){if(ids.has(row.id))throw Error('Il backup contiene un esame già presente. L’importazione non sovrascrive esami esistenti.');out.exams.push(exam(row,{legacy:true}));ids.add(row.id);}if(command.settings)out.settings=settings(command.settings);
  }else throw Error('Operazione libretto non valida.');
  if(out.exams.length>MAX_EXAMS)throw Error('Il libretto può contenere fino a 500 esami.');return out;
 }
 function backup(value,accountId){return{format:FORMAT,version:1,accountId,exportedAt:new Date().toISOString(),settings:settings(value.settings),exams:clone(value.exams||[])};}
 function importPreview(text,current,accountId){
  if(typeof text!=='string'||text.length>1500000)throw Error('Il file è troppo grande per un backup del libretto.');let value;try{value=JSON.parse(text);}catch{throw Error('Il file non contiene JSON valido.');}
  if(value?.format!==FORMAT||value.version!==1||!Array.isArray(value.exams)||value.exams.length>MAX_EXAMS)throw Error('Il file non è un backup del Libretto Sgiungla supportato.');
  const seen=new Set(),existing=new Set((current.exams||[]).map(x=>x.id)),exams=value.exams.map(row=>exam(row,{legacy:true}));for(const row of exams){if(seen.has(row.id))throw Error('Il backup contiene esami duplicati.');seen.add(row.id);}
  const duplicates=exams.filter(x=>existing.has(x.id)).length,foreign=!!value.accountId&&value.accountId!==accountId;
  // A bank ID from another account is never automatically linked to this owner.
  if(foreign)for(const row of exams)row.courseId=null;
  return{exams,settings:settings(value.settings),duplicates,foreign,passed:exams.filter(x=>x.status==='passed').length,credits:exams.filter(x=>x.status==='passed').reduce((n,x)=>n+(Number(x.credits)||0),0)};
 }
 const defaultStorage={getItem:key=>root.localStorage.getItem(key),setItem:(key,value)=>root.localStorage.setItem(key,value),removeItem:key=>root.localStorage.removeItem(key)};
 function controller(options){
  const accountId=options.accountId;if(!validId(accountId))throw Error('Accedi al tuo account per aprire il libretto.');
  const key='unisgiunglalab.gradebook.v1.'+accountId,storage=options.storage||defaultStorage,listeners=new Set();let state=null,loading=null,syncing=null,refreshing=null,lastReadAt=0,nextRetryAt=0,disposed=false;
  const valid=()=>!disposed&&(!options.currentAccount||options.currentAccount()===accountId)&&(!options.canUse||options.canUse());
  const assert=()=>{if(!valid())throw Object.assign(Error('Accesso al libretto non disponibile o account cambiato.'),{code:'ACCOUNT_CHANGED'});};
  const lockTails=new Map();
  const lock=(name,fn)=>{const previous=lockTails.get(name)||Promise.resolve(),pending=previous.catch(()=>{}).then(()=>root.navigator?.locks?.request?root.navigator.locks.request('quizlab-gradebook:'+accountId+':'+name,fn):fn());lockTails.set(name,pending);return pending.finally(()=>{if(lockTails.get(name)===pending)lockTails.delete(name);});};
  const emit=()=>{for(const fn of listeners)try{fn(view());}catch{}};
  const changed=()=>{if(valid())try{Promise.resolve(options.onChange?.()).catch(()=>{});}catch{}};
  async function load(){if(state)return state;if(loading)return loading;loading=(async()=>{const raw=await storage.getItem(key);if(raw){let s;try{s=JSON.parse(raw);}catch{throw Error('Archivio locale del libretto non leggibile. Non è stato sovrascritto.');}if(s.version!==1||s.accountId!==accountId||!Array.isArray(s.queue))throw Error('Archivio locale non valido per questo account.');snapshot(s.confirmed);state=s;}else state={version:1,accountId,confirmed:empty(),queue:[],conflict:null,lastLocalAt:null,lastSyncAt:null};return state;})();try{return await loading;}finally{loading=null;}}
  function view(){
   if(!state)return{snapshot:empty(),pending:0,conflict:null,lastLocalAt:null,lastSyncAt:null,hasData:false};
   let data=clone(state.confirmed);for(const job of state.queue)data=apply(data,job);
   return{snapshot:data,pending:state.queue.length,conflict:state.conflict?clone(state.conflict):null,lastLocalAt:state.lastLocalAt,lastSyncAt:state.lastSyncAt,hasData:!!(state.lastLocalAt||state.lastSyncAt),syncing:!!syncing};
  }
  async function change(fn){return lock('persist',async()=>{await load();const raw=await storage.getItem(key);if(raw){const latest=JSON.parse(raw);if(latest.accountId!==accountId||latest.version!==1)throw Error('Archivio locale non valido.');state=latest;}const next=clone(state);await fn(next);await storage.setItem(key,JSON.stringify(next));state=next;emit();return view();});}
  async function enqueue(command){
   assert();let finish=()=>{};try{finish=root.QuizLabPerformance?.start?.('gradebook_save')||finish;}catch{}
   const observed=ok=>{try{finish({ok});}catch{}};
   try{await load();const job=clone(command);if(job.action==='save-exam')job.exam=exam(job.exam);if(job.action==='save-settings')job.settings=settings(job.settings);if(job.action==='delete-exam'&&!validId(job.id))throw Error('Esame non valido.');job.mutationId=id();job.createdAt=new Date().toISOString();
    await change(next=>{assert();if(next.queue.length>=500)throw Error('Ci sono troppe modifiche in attesa. Sincronizza prima di aggiungerne altre.');let data=clone(next.confirmed);for(const queued of next.queue)data=apply(data,queued);apply(data,job);next.queue.push(job);next.lastLocalAt=job.createdAt;});observed(true);void flush().catch(()=>{});return view();
   }catch(error){observed(false);throw error;}
  }
  function transient(error){return !error?.status||[402,408,429].includes(Number(error.status))||Number(error.status)>=500;}
  async function flush({force=false}={}){
   assert();await load();if(syncing)return syncing;if(!options.request||root.navigator?.onLine===false||!force&&Date.now()<nextRetryAt)return view();
   syncing=lock('sync',async()=>{
    let sends=0;
    while(valid()&&sends++<500){await change(()=>{});if(state.conflict||!state.queue.length)break;const job=clone(state.queue[0]),revision=state.confirmed.revision;
     try{const response=await options.request('gradebook',{...job,expectedRevision:revision});assert();const confirmed=snapshot(response);await change(next=>{if(confirmed.revision>=next.confirmed.revision)next.confirmed=confirmed;next.queue=next.queue.filter(x=>x.mutationId!==job.mutationId);next.lastSyncAt=new Date().toISOString();next.conflict=null;});nextRetryAt=0;lastReadAt=Date.now();changed();}
     catch(error){if(!valid())throw error;if(Number(error.status)===409){let current=null;try{if(error.current)current=snapshot(error.current);}catch{}await change(next=>{next.conflict={message:error.message||'Il libretto è cambiato su un altro dispositivo.',current,at:new Date().toISOString()};});break;}
      nextRetryAt=Date.now()+(Number(error.status)===402?900000:Number(error.status)===429?60000:30000);if(!transient(error))await change(next=>{next.conflict={message:error.message||'Modifica da verificare.',current:null,at:new Date().toISOString()};});throw error;
     }
    }return view();
   });emit();try{return await syncing;}finally{syncing=null;emit();}
  }
  async function refresh({force=false}={}){
   assert();await load();if(refreshing)return refreshing;
   refreshing=(async()=>{if(state.queue.length){await flush({force});if(state.queue.length||state.conflict)return view();}
    if(!options.request||root.navigator?.onLine===false||!force&&Date.now()<nextRetryAt||!force&&Date.now()-lastReadAt<300000)return view();
    try{const response=await options.request('gradebook');assert();const confirmed=snapshot(response);await change(next=>{if(!next.queue.length&&confirmed.revision>=next.confirmed.revision){next.confirmed=confirmed;next.lastSyncAt=new Date().toISOString();}});lastReadAt=Date.now();nextRetryAt=0;return view();}
    catch(error){nextRetryAt=Date.now()+(Number(error.status)===402?900000:Number(error.status)===429?60000:30000);throw error;}
   })();try{return await refreshing;}finally{refreshing=null;}
  }
  async function resolve(choice){assert();await load();if(!state.conflict)return view();let current=state.conflict.current;if(!current){current=snapshot(await options.request('gradebook'));assert();}await change(next=>{if(choice==='cloud')next.queue=[];else if(choice==='local'){let projected=clone(current);for(const job of next.queue)projected=apply(projected,job);}else throw Error('Scegli quale versione conservare.');next.confirmed=current;next.conflict=null;next.lastLocalAt=new Date().toISOString();});return choice==='local'?flush({force:true}):view();}
  const online=()=>{if(valid())flush().catch(()=>{});};root.addEventListener?.('online',online);
  return{accountId,load:async()=>{await load();return view();},view,enqueue,refresh,flush,resolve,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},update(next){if(next.accountId!==accountId)throw Error('Account cambiato.');options=next;},dispose(){disposed=true;listeners.clear();root.removeEventListener?.('online',online);},backup:()=>backup(view().snapshot,accountId)};
 }
 function getController(options){const key=options.accountId;let item=controllers.get(key);if(!item){item=controller(options);controllers.set(key,item);}else item.update(options);return item;}
 root.QuizLabGradebookCore=Object.freeze({FORMAT,MAX_EXAMS,settings,exam,snapshot,empty,calculate,simulate,apply,backup,importPreview,controller,getController,today});
})(globalThis);
