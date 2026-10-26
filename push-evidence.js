// Transfer bounded service-worker evidence only after account authentication.
export async function syncPushEvidence(userId,request,preferences){
 if(!userId||!navigator.serviceWorker?.controller)return;
 const controller=navigator.serviceWorker.controller;
 const p=preferences||await request('preferences');controller.postMessage({type:'QUIZLAB_PUSH_POLICY',userId,settings:p.settings});
 const channel=new MessageChannel();
 const events=await new Promise(resolve=>{const timer=setTimeout(()=>{channel.port1.close();resolve([]);},2000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(Array.isArray(e.data)?e.data:[]);};controller.postMessage({type:'QUIZLAB_PUSH_EVIDENCE_READ',userId},[channel.port2]);});
 const keys=[];for(const event of events){if(event.userId!==userId)continue;const r=await request('receipt',{notification_id:event.notification_id,device_id:event.device_id,event:event.event});if(r.ok)keys.push(event.key);}
 if(keys.length)controller.postMessage({type:'QUIZLAB_PUSH_EVIDENCE_ACK',userId,keys});
}
