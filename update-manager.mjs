const KEY='quizlab.update.checkpoint.v1';
export function restoreUpdateCheckpoint({accountId,courses}){
 try{
  const value=JSON.parse(sessionStorage.getItem(KEY)||'null');
  // A checkpoint belongs to exactly this reload, not to a future login by the
  // previous account. Discarding it never removes durable study progress.
  sessionStorage.removeItem(KEY);
  if(!value||value.version!==1||value.accountId!==accountId||!Number.isFinite(value.savedAt)||value.savedAt>Date.now()+60000||Date.now()-value.savedAt>86400000)return null;
  if(!value.route||typeof value.route.name!=='string')return null;
  if(value.session){
   const course=courses?.[value.route.courseId];if(!course||!Array.isArray(value.session.questions))return null;
   const known=new Set([...(course.officialBank||[]),...(course.aiBank||[])].map(q=>q.id));
   if(!value.session.questions.every(q=>q&&known.has(q.id)))return null;
   if(!Number.isSafeInteger(value.session.index)||value.session.index<0||value.session.index>=value.session.questions.length)return null;
  }
  return value;
 }catch{return null;}
}
export async function installUpdates({version,checkpoint}){
 let pending=null;
 async function save(){
  const value=await checkpoint();sessionStorage.setItem(KEY,JSON.stringify({...value,version:1,fromRelease:version,savedAt:Date.now()}));return value;
 }
 async function reload(){
  if(pending)return pending;
  pending=(async()=>{
   document.getElementById('app')?.setAttribute('inert','');
   try{await save();location.reload();}
   catch{document.getElementById('app')?.removeAttribute('inert');pending=null;show('Aggiornamento in attesa: il salvataggio non è riuscito. Conserva questa pagina aperta.');}
  })();return pending;
 }
 function show(message){let box=document.getElementById('quizlab-update-status');if(!box){box=document.createElement('aside');box.id='quizlab-update-status';box.setAttribute('role','status');box.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;padding:14px;background:#103d53;color:#fff;text-align:center';document.body.append(box);}box.textContent=message;}
 navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='QUIZLAB_UPDATE_FAILED')show('Aggiornamento non verificato. I dati restano conservati. Riprova quando la rete è disponibile.');});
 navigator.serviceWorker.addEventListener('controllerchange',()=>{if(navigator.serviceWorker.controller)reload();});
 const registration=await navigator.serviceWorker.register('./service-worker.js',{updateViaCache:'none'});
 async function activate(){
  if(!registration.waiting)return;
  try{await save();show('Aggiornamento pronto. Salvataggio completato, riapertura in corso…');registration.waiting.postMessage({type:'QUIZLAB_ACTIVATE_UPDATE'});}
  catch{show('Aggiornamento in attesa del salvataggio. I dati restano su questo dispositivo.');}
 }
 registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)activate();});});
 globalThis.quizlabApplyUpdate=async()=>{
  await registration.update();
  const installing=registration.installing;
  if(installing&&installing.state!=='installed')await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{installing.removeEventListener('statechange',changed);reject(Error('Aggiornamento ancora in preparazione. I dati restano conservati.'));},30000);
   function changed(){if(['installed','activated','redundant'].includes(installing.state)){clearTimeout(timer);installing.removeEventListener('statechange',changed);installing.state==='redundant'?reject(Error('Aggiornamento non verificato. Riprova quando la rete è disponibile.')):resolve();}}
   installing.addEventListener('statechange',changed);changed();
  });
  if(registration.waiting)await activate();else await reload();
 };
 // register() already starts the first installation. Starting another update
 // job while that worker is still installing can replace it with a redundant
 // worker before the first controller exists (Chrome may report Not found).
 if(registration.active&&!registration.installing)await registration.update();
 await activate();
}
