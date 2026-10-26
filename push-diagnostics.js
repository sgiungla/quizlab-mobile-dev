// Read-only browser inspection. Never requests permission or sends a push.
async function bounded(promise,ms,message){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}
}
export async function collectPushDiagnostics(userId,{serviceWorker=navigator.serviceWorker,permission=globalThis.Notification?.permission||'unsupported',Channel=MessageChannel,timeoutMs=2500,operationTimeoutMs=3000}={}){
 const reg=await bounded(serviceWorker?.getRegistration(),operationTimeoutMs,'Il browser non risponde al controllo del ricevitore. Ricarica normalmente QuizLab con F5.');
 // A hard reload can bypass the page controller while the registered worker
 // remains active and able to receive remote pushes. Inspect that worker.
 const controller=reg?.active||serviceWorker?.controller;
 if(!reg||!controller||controller.state==='redundant')throw Error('Ricevitore non ancora avviato. Ricarica normalmente QuizLab con F5.');
 const channel=new Channel();
 const data=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{channel.port1.close();channel.port2.close();reject(Error('Il ricevitore non risponde alla diagnostica. Ricarica QuizLab con Ctrl+F5.'));},timeoutMs);
  channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(event.data);};
  try{controller.postMessage({type:'QUIZLAB_PUSH_DIAGNOSTICS_READ',userId},[channel.port2]);}catch(error){clearTimeout(timer);channel.port1.close();channel.port2.close();reject(error);}
 });
 if(data?.receiverVersion!=='lab-push-diagnostics-1'||!Array.isArray(data.rows))throw Error('Diagnostica non disponibile nel ricevitore attuale. Ricarica QuizLab.');
 const subscription=await bounded(reg.pushManager?.getSubscription(),operationTimeoutMs,'Il browser non risponde al controllo della registrazione push.');let subscriptionFingerprint=null;
 if(subscription){
  const raw=subscription.toJSON(),normalized={endpoint:raw.endpoint,keys:{p256dh:raw.keys.p256dh,auth:raw.keys.auth}};
  const bytes=await bounded(crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(normalized))),operationTimeoutMs,'Il confronto della registrazione push non è stato completato.');
  subscriptionFingerprint=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 }
 return{...data,permission,workerState:controller.state||'unknown',subscriptionRegistered:!!subscription,subscriptionFingerprint};
}
