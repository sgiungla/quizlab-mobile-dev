// Refresh only report views, never an administrator's unsaved forms or preview.
export function createHistoryMonitor({context,load,apply,onError=()=>{},visible=()=>document.visibilityState==='visible',blocked=()=>false,now=()=>Date.now(),intervalMs=60000}){
 let running=false,lastCheck=null,disposed=false;
 const key=c=>JSON.stringify(c);
 async function check(force=false){
  const current=context();
  if(disposed||running||blocked()||!visible()||!current||!force&&lastCheck!==null&&now()-lastCheck<intervalMs)return false;
  running=true;lastCheck=now();const expected=key(current);
  try{
   const result=await load(current);
   if(disposed||blocked()||!visible()||expected!==key(context()))return false;
   apply(result);return true;
  }catch(error){if(!disposed&&expected===key(context()))onError(error);return false;}
  finally{running=false;}
 }
 return{check,dispose(){disposed=true;}};
}
