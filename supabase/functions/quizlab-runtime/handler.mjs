// No private credentials or key material are included in responses, logs or client assets.
import {validateEgress,egressView} from './egress.mjs';
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64url=bytes=>encode(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const legacyFeatures=['lessons','kit_ai','question_banks','handouts','quizlab_desktop','quizlab_pwa'];
const features=[...legacyFeatures,'gradebook'];
export function createHandler({url,serviceKey,anonKey,fetcher=fetch,clock=()=>new Date()}){
 let keyPromise=null;
 async function jsonRequest(path,{token,body,service=false,method='POST'}={}){
  const response=await fetcher(url+path,{method,signal:AbortSignal.timeout(10000),headers:{apikey:service?serviceKey:anonKey,Authorization:'Bearer '+(service?serviceKey:token),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok){
   let code;try{code=(await response.json())?.code;}catch{await response.body?.cancel().catch(()=>{});}
   const status=code==='40001'?409:code==='22023'?400:code==='42501'?403:response.status;
   const message=status===402?'Cloud temporaneamente limitato':status===401?'Accedi nuovamente al tuo account':status===409?'Valori aggiornati da un altro amministratore: rileggi il monitor.':status===400?'Dati della rilevazione non validi':'Operazione non disponibile';
   throw Object.assign(new Error(message),{status});
  }
  return response.json();
 }
 const rpc=(name,body,token)=>jsonRequest('/rest/v1/rpc/'+name,{token,body});
 async function signingKey(){
  if(!keyPromise)keyPromise=(async()=>{
   let stored=await jsonRequest('/rest/v1/rpc/quizlab_runtime_key',{service:true,body:{}});
   if(!stored){
    const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
    const candidate={algorithm:'Ed25519',privateJwk:await crypto.subtle.exportKey('jwk',pair.privateKey),publicSpki:encode(await crypto.subtle.exportKey('spki',pair.publicKey))};
    stored=await jsonRequest('/rest/v1/rpc/quizlab_runtime_key',{service:true,body:{candidate}});
   }
   if(stored?.algorithm!=='Ed25519'||!stored.publicSpki||!stored.privateJwk)throw new Error('Verifica accesso non disponibile');
   return {publicSpki:stored.publicSpki,key:await crypto.subtle.importKey('jwk',stored.privateJwk,{name:'Ed25519'},false,['sign'])};
  })().catch(error=>{keyPromise=null;throw error;});
  return keyPromise;
 }
 return async request=>{
  const origin=request.headers.get('Origin'),allowed=!origin||['https://sgiungla.github.io','https://lms.pegaso.multiversity.click'].includes(origin)||/^(chrome|edge)-extension:\/\/[a-p]{32}$/.test(origin);
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin',...(allowed&&origin?{'Access-Control-Allow-Origin':origin}:{}),'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,content-profile,accept-profile','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
  const answer=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
  if(!allowed)return answer({message:'Origin non consentita'},403);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
  try{
   const path=new URL(request.url).pathname.split('/quizlab-runtime')[1]||'/';
   if(path==='/key'&&request.method==='GET')return answer({algorithm:'Ed25519',publicKey:(await signingKey()).publicSpki,release:'0.11.29'});
   if(!['/license','/egress'].includes(path))return answer({message:'Operazione non disponibile'},404);
   if((path==='/license'&&request.method!=='POST')||(path==='/egress'&&!['GET','POST'].includes(request.method)))return answer({message:'Metodo non consentito'},405);
   const authorization=request.headers.get('Authorization');
   if(!/^Bearer \S+$/i.test(authorization||''))return answer({message:'Accesso richiesto'},401);
   const token=authorization.replace(/^Bearer /i,'');
   if(!token||token.length>8192)return answer({message:'Accesso richiesto'},401);
   // Supabase verifies the token; no role is inferred from user-editable metadata.
   const user=await jsonRequest('/auth/v1/user',{token,method:'GET'});
   if(!user?.id)return answer({message:'Account non verificato'},401);
   if(path==='/license'){
    const state=await rpc('quizlab_license_status',{},token);
    if(state?.userId!==user.id||!['active','pending','suspended','expired'].includes(state.status)||!Array.isArray(state.features)||state.features.some(x=>!features.includes(x))||new Set(state.features).size!==state.features.length)throw new Error('Risposta accesso non valida');
    const issued=Date.parse(state.serverTime);if(!Number.isFinite(issued)||Math.abs(clock().getTime()-issued)>60000)throw new Error('Verifica orario non disponibile');
    const expiry=state.expiresAt?Date.parse(state.expiresAt):issued+86400000;
    if(!Number.isFinite(expiry))throw new Error('Scadenza accesso non valida');
    const validUntil=Math.max(issued,Math.min(issued+86400000,expiry));
    // Negotiate only the vocabulary, never the permissions. Existing clients
    // reject unknown feature names, so retain their signed six-module lease.
    const vocabulary=new URL(request.url).searchParams.get('client_modules')==='2'?features:legacyFeatures;
    const payload={version:2,userId:user.id,status:state.status,isAdmin:state.isAdmin===true,features:(state.features||[]).filter(x=>vocabulary.includes(x)),licenseRevision:Number(state.licenseRevision),issuedAt:new Date(issued).toISOString(),validUntil:new Date(validUntil).toISOString(),expiresAt:state.expiresAt||null};
    if(!Number.isSafeInteger(payload.licenseRevision)||payload.licenseRevision<1)throw new Error('Versione accesso non disponibile');
    const encoded=base64url(new TextEncoder().encode(JSON.stringify(payload))),key=await signingKey();
    const signature=await crypto.subtle.sign('Ed25519',key.key,new TextEncoder().encode(encoded));
    return answer({token:encoded+'.'+base64url(signature)});
   }
   // Validation and database authorization both apply; the service role is never used for admin operations.
   let input=null;
   if(request.method==='POST'){
    const reader=request.body?.getReader();let raw='',size=0;
    if(reader){const decoder=new TextDecoder();try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384){await reader.cancel();return answer({message:'Dati troppo grandi'},413);}raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}}
    const body=JSON.parse(raw);const valid=validateEgress(body,clock());
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)return answer({message:'Revisione non valida'},400);
    input={...valid,expectedRevision:body.expectedRevision};
   }
   const result=await rpc('quizlab_admin_egress',{input},token);
   return answer(egressView(result,clock()));
  }catch(error){
   const status=Number(error.status)||(/JSON|Soglie|Byte|quota|Data|Periodo|Fonte|Rilevazione|consumo|Campi/.test(error.message)?400:503);
   return answer({message:status===503?'Cloud temporaneamente non disponibile. I dati locali restano conservati.':error.message},status);
  }
 };
}
