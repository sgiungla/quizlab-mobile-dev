import {DEFAULT_CLOUD_CONFIG} from './cloud-config.js';
import {readUserCourses} from './db.js';
import {createAdminUserListState,adminUserPageRequest,readAdminUserFilters,renderAdminUserList,renderAdminUserDetails,applyAdminUserPage,resetAdminUserFilters,updateAdminUserFilters,adminEffectiveStatus} from './admin-user-list.js';

const BANK_SCHEMA='unisgiunglalab.quizlab.bank',BACKUP_SCHEMA='unisgiunglalab.quizlab.backup';
const cleanText=value=>String(value??'').replace(/\s+/g,' ').trim();
const statusLabel=value=>({active:'Attivo',pending:'In attesa',suspended:'Sospeso',expired:'Scaduto'}[value]||'Da verificare');
const PRODUCT_MODULES=Object.freeze([
 ['lessons','Lezioni'],['kit_ai','Kit AI'],['question_banks','Panieri'],['handouts','Dispense'],['quizlab_desktop','QuizLab desktop'],['quizlab_pwa','QuizLab web app']
]);
function moduleFlags(raw){return Object.fromEntries(PRODUCT_MODULES.map(([key])=>[key,raw?.[key]!==false]));}
function moduleNames(raw){const flags=moduleFlags(raw);return PRODUCT_MODULES.filter(([key])=>flags[key]).map(([,label])=>label).join(', ')||'Nessuno strumento';}
function readModuleOverrides(){
 const overrides={};
 for(const [key] of PRODUCT_MODULES){const value=el('module-'+key).value;if(value==='allow')overrides[key]=true;else if(value==='deny')overrides[key]=false;else if(value!=='inherit')throw new Error('Selezione strumento non valida');}
 return overrides;
}
function previewUserModules(){
 const user=userCache.get(el('targetUser').value);if(!user)return;
 const baseline=moduleFlags(user.module_defaults),overrides=readModuleOverrides(),effective={...baseline,...overrides};
 el('effectiveModules').textContent='Strumenti dopo il salvataggio: '+moduleNames(effective)+'. '+(user.is_admin?'L’amministratore conserva tutti gli strumenti.':'Le scelte esplicite restano anche dopo un cambio di piano; «Dal piano» segue il contratto attivo.');
 return effective;
}
function fillUserModules(user){
 for(const [key] of PRODUCT_MODULES)el('module-'+key).value=Object.hasOwn(user.module_overrides||{},key)?(user.module_overrides[key]?'allow':'deny'):'inherit';
 previewUserModules();
}
function userAccessDraft(){
 const user=selectedUser(),status=el('targetStatus').value;
 if(user.is_admin)throw new Error('Account amministratore protetto');
 if(!['pending','active','suspended'].includes(status))throw new Error('Stato non valido');
 const revision=Number(user.license_revision);if(!Number.isSafeInteger(revision)||revision<1)throw new Error('Aggiorna la scheda prima di cambiare gli strumenti');
 return{target_user_id:user.user_id,approval_status:status,module_overrides:readModuleOverrides(),expected_license_revision:revision};
}
const reserved=value=>['__proto__','constructor','prototype'].includes(value);
function courseId(value){
 const id=cleanText(value);
 if(!id||id.length>256||reserved(id))throw new Error('Identificativo materia non valido');
 return id;
}
function contentStrings(value,limit=50000){
 if(value==null)return [];
 if(!Array.isArray(value)||value.length>limit)throw new Error('Elenco metadati non valido');
 return value.map(item=>cleanText(item)).filter(Boolean);
}
function warningResolution(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const status=cleanText(raw.status||raw.validationStatus).toLowerCase();if(!status)return null;
 const sources=(Array.isArray(raw.sources)?raw.sources:[]).slice(0,100).map(item=>{
  if(typeof item==='string'){const text=cleanText(item);return /^https?:\/\//i.test(text)?{type:'external',title:'',url:text,reference:''}:{type:'external',title:'',url:'',reference:text};}
  if(!item||typeof item!=='object'||Array.isArray(item))return null;
  const url=cleanText(item.url);
  return {type:cleanText(item.type||item.sourceType||'external').toLowerCase(),title:cleanText(item.title||item.name||item.organization),url:/^https?:\/\//i.test(url)?url:'',reference:cleanText(item.reference||item.citation)};
 }).filter(item=>item&&(item.title||item.url||item.reference));
 return {status,reason:cleanText(raw.reason||raw.note),explanation:cleanText(raw.explanation),supportedOptionId:cleanText(raw.supportedOptionId||raw.supported_option_id),sources,resolvedAt:cleanText(raw.resolvedAt||raw.resolved_at),auditedAt:cleanText(raw.auditedAt||raw.audited_at||raw.resolvedAt||raw.resolved_at)};
}
function contentTopicMap(raw){
 if(raw==null)return null;
 if(typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.chapters))throw new Error('Mappa argomenti non valida');
 const chapterIds=new Set(),topicIds=new Set();
 const chapters=raw.chapters.map(ch=>{
  const chapter=Number(ch?.chapter);
  if(!Number.isSafeInteger(chapter)||chapter<1||chapterIds.has(chapter)||!Array.isArray(ch.topics))throw new Error('Capitolo mappa non valido o duplicato');
  chapterIds.add(chapter);
  const topics=ch.topics.map(item=>{
   const id=cleanText(item?.id||item?.topicId||item?.topic_id),name=cleanText(item?.name||item?.topic||item?.argomento);
   if(!id||reserved(id)||!name||topicIds.has(id))throw new Error('Argomento mappa non valido o duplicato');
   topicIds.add(id);
   const questionPlan={};
   for(const difficulty of ['easy','medium','hard']){
    const count=Number(item.questionPlan?.[difficulty]||0);
    if(!Number.isSafeInteger(count)||count<0||count>100000)throw new Error('Piano domande non valido');
    questionPlan[difficulty]=count;
   }
   return {id,name,importance:cleanText(item.importance).toLowerCase()==='supporting'?'supporting':'core',sourceReferences:contentStrings(item.sourceReferences??[item.reference||item.sourceReference]),officialQuestionIds:contentStrings(item.officialQuestionIds),questionPlan};
  });
  return {chapter,chapterTitle:cleanText(ch.chapterTitle||ch.title||'Capitolo '+chapter),topics};
 });
 const plannedAiTotal=chapters.reduce((total,ch)=>total+ch.topics.reduce((count,item)=>count+Object.values(item.questionPlan).reduce((sum,n)=>sum+n,0),0),0);
 return {schema:cleanText(raw.schema||'unisgiunglalab.quizlab.topicmap'),version:Number(raw.version)||1,course:{courseId:cleanText(raw.course?.courseId),subject:cleanText(raw.course?.subject)},chapters,plannedAiTotal,topicCount:topicIds.size,signature:cleanText(raw.signature),createdAt:cleanText(raw.createdAt)};
}
function contentQuality(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
 const out={};
 for(const key of ['level','icon','label'])if(raw[key]!=null)out[key]=cleanText(raw[key]);
 for(const key of ['sample','longestRate','strongLengthCueRate','lengthRatio','repeatedStemRate','repeatedExplanationRate','dominantKindRate'])if(Number.isFinite(Number(raw[key])))out[key]=Number(raw[key]);
 if(raw.notes)out.notes=contentStrings(raw.notes,1000);
 if(raw.difficultyCounts)out.difficultyCounts=Object.fromEntries(['easy','medium','hard'].map(key=>[key,Math.max(0,Number(raw.difficultyCounts[key])||0)]));
 if(raw.kindCounts&&typeof raw.kindCounts==='object')out.kindCounts=Object.fromEntries(Object.entries(raw.kindCounts).filter(([key,value])=>!reserved(key)&&Number.isFinite(Number(value))).map(([key,value])=>[cleanText(key),Number(value)]));
 return out;
}
function contentWorkflow(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {};
 const out={protocolVersion:typeof raw.protocolVersion==='number'&&Number.isFinite(raw.protocolVersion)?raw.protocolVersion:cleanText(raw.protocolVersion),topicMapSignature:cleanText(raw.topicMapSignature)};
 for(const key of ['importedBlocks','validationWarnings'])if(raw[key])out[key]=contentStrings(raw[key]);
 for(const key of ['plannedAiTotal','generatedAiTotal','officialExplained','officialWarnings','warningOpen','warningPending','warningResolved','warningUnresolved','warningAudited','completeAiChapters','mapChapters'])if(Number.isFinite(Number(raw[key])))out[key]=Number(raw[key]);
 for(const key of ['auditComplete','exportedComplete'])if(typeof raw[key]==='boolean')out[key]=raw[key];
 if(raw.quality)out.quality=contentQuality(raw.quality);
 if(raw.blockQuality&&typeof raw.blockQuality==='object'&&!Array.isArray(raw.blockQuality))out.blockQuality=Object.fromEntries(Object.entries(raw.blockQuality).filter(([key])=>!reserved(key)).map(([key,value])=>[key,contentQuality(value)]));
 return out;
}
function question(raw,source){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.options)||raw.options.length!==4)throw new Error('Domanda non valida');
 const id=cleanText(raw.id),chapter=Number(raw.chapter??raw.chapterNumber),text=cleanText(raw.text??raw.question);
 if(!id||id.length>256||reserved(id)||!Number.isSafeInteger(chapter)||chapter<1||chapter>100000||!text||text.length>100000)throw new Error('ID, capitolo o testo domanda non validi');
 const options=raw.options.map((item,index)=>({letter:cleanText(item?.letter||['A','B','C','D'][index]).toUpperCase(),optionId:cleanText(item?.optionId||item?.id||('opt_'+(index+1))),text:cleanText(item?.text??item)}));
 if(options.some(item=>!/^[A-D]$/.test(item.letter)||!item.optionId||!item.text||item.text.length>100000)||new Set(options.map(item=>item.letter)).size!==4||new Set(options.map(item=>item.optionId)).size!==4)throw new Error('Opzioni non valide o duplicate');
 let correct=cleanText(raw.correct||raw.correctAnswer).toUpperCase();
 const coi=cleanText(raw.correctOptionId||raw.correct_option_id);
 if(coi){const option=options.find(item=>item.optionId===coi);if(!option)throw new Error('correctOptionId non presente');correct=option.letter;}
 const answer=options.find(item=>item.letter===correct);if(!answer)throw new Error('Risposta corretta non presente');
 // Keep only question content; account credentials, progress and client state
 // are never sent by the assignment console, even when the input is a backup.
 return {id,chapter,source,text,options,correct,correctOptionId:answer.optionId,
  explanation:cleanText(raw.explanation||raw.spiegazione),reference:cleanText(raw.reference||raw.fonte||raw.sourceReference),
  validationWarning:!!(raw.validationWarning||raw.validation_warning),validationNote:cleanText(raw.validationNote||raw.validation_note),warningResolution:warningResolution(raw.warningResolution||raw.warning_resolution),
  ...(raw.kind||raw.questionKind?{kind:cleanText(raw.kind||raw.questionKind)}:{}),
  ...(Number.isFinite(Number(raw.number))?{number:Number(raw.number)}:{}),
  difficulty:['easy','medium','hard'].includes(cleanText(raw.difficulty).toLowerCase())?cleanText(raw.difficulty).toLowerCase():'medium',
  ...(raw.topic?{topic:cleanText(raw.topic)}:{}),...(raw.topicId?{topicId:cleanText(raw.topicId)}:{}),...(raw.chapterTitle?{chapterTitle:cleanText(raw.chapterTitle)}:{})};
}
function normalizeAdminBank(raw,allowEmpty=false){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Banca non valida');
 const output={officialBank:[],aiBank:[],topicMap:contentTopicMap(raw.topicMap),aiWorkflow:contentWorkflow(raw.aiWorkflow)},ids=new Set();
 for(const [key,source] of [['officialBank','official'],['aiBank','ai']]){
  const rows=raw[key]??[];
  if(!Array.isArray(rows)||rows.length>50000)throw new Error('Banca troppo grande o non valida');
  rows.forEach((item,index)=>{
   let row;try{row=question(item,source);}catch(error){throw new Error(key+', domanda '+(index+1)+': '+error.message);}
   if(ids.has(row.id))throw new Error('ID domanda duplicato tra banche: '+row.id);
   ids.add(row.id);output[key].push(row);
  });
 }
 if(ids.size>20000||new TextEncoder().encode(JSON.stringify(output)).length>8*1024*1024)throw new Error('Banca oltre la quota: massimo 20.000 domande e 8 MB');
 if(!ids.size&&!allowEmpty)throw new Error('Nessuna domanda da assegnare');
 return output;
}
function extractBankCandidates(pack){
 if(!pack||typeof pack!=='object'||Array.isArray(pack))throw new Error('JSON non valido');
 if(pack.schema===BACKUP_SCHEMA){
  if(!pack.store?.courses||typeof pack.store.courses!=='object'||Array.isArray(pack.store.courses))throw new Error('Backup non valido');
  const entries=Object.entries(pack.store.courses);
  if(entries.length>500)throw new Error('Backup troppo grande');
  return entries.filter(([,raw])=>(raw?.officialBank?.length||0)+(raw?.aiBank?.length||0)>0)
   .map(([id,raw])=>({courseId:courseId(id),subject:cleanText(raw.subject||id),bank:normalizeAdminBank(raw)}));
 }
 if(pack.schema!==BANK_SCHEMA)throw new Error('Serve una Banca QuizLab COMPLETA o un backup');
 const id=courseId(pack.course?.courseId);
 return [{courseId:id,subject:cleanText(pack.course?.subject||id),bank:normalizeAdminBank(pack)}];
}
function expiryUtc(value,noExpiry=false){
 if(noExpiry)return null;
 if(!value||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))throw new Error('Imposta una data e un’ora oppure seleziona Nessuna scadenza');
 const date=new Date(value);
 if(!Number.isFinite(date.getTime())||dateInput(date.toISOString())!==value)throw new Error('Scadenza non valida');
 return date.toISOString();
}
function dateInput(iso){
 if(!iso)return '';
 const date=new Date(iso);if(!Number.isFinite(date.getTime()))return '';
 const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
 return local.toISOString().slice(0,16);
}

const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=(cents,currency='EUR')=>new Intl.NumberFormat('it-IT',{style:'currency',currency}).format(Number(cents||0)/100);
const dateLabel=iso=>iso?new Date(iso).toLocaleString('it-IT'):'Nessuna';
const bankCount=bank=>(bank?.officialBank?.length||0)+(bank?.aiBank?.length||0);
let client=null,session=null,users=[],assignments=[],candidates=[],generation=0,targetGeneration=0,sourceGeneration=0,destinationGeneration=0,busy=false,isAdmin=false;
let adminSignedOutLocally=false,adminAuthIntentGeneration=0,adminAuthTransition=Promise.resolve();
const adminAuthStorageKeys=new Set();
const adminIdentityKey='quizlab.auth.identity.v1';
function adminAuthStorage(){
 return {
  getItem(key){adminAuthStorageKeys.add(key);return globalThis.localStorage?.getItem(key)??null;},
  setItem(key,value){adminAuthStorageKeys.add(key);if(!adminSignedOutLocally)globalThis.localStorage?.setItem(key,value);},
  removeItem(key){adminAuthStorageKeys.add(key);globalThis.localStorage?.removeItem(key);}
 };
}
function clearAdminAuthStorage(){for(const key of adminAuthStorageKeys){try{globalThis.localStorage?.removeItem(key);}catch{}}}
function forgetAdminLocalIdentity(){try{globalThis.localStorage?.removeItem(adminIdentityKey);}catch{}}
function enqueueAdminAuth(operation){const run=adminAuthTransition.then(operation,operation);adminAuthTransition=run.catch(()=>{});return run;}
let confirmation=null,selectedTargetId='',targetDetail=null,destinationSnapshot=null,history=[],restorePreview=null,contractPreview=null,plans=[];
const userCache=new Map(),requests=new Map(),userList=createAdminUserListState();
const contextToken=({target=true}={})=>({generation,user:session?.user?.id||null,...(target?{target:el('targetUser').value,targetGeneration}:{})});
function permitted(){return !!session&&isAdmin&&globalThis.UniSgiunglaLicense?.canUseFeatures()===true;}
function assertContext(token){
 if(token.generation!==generation||token.user!==(session?.user?.id||null)||('target'in token&&(token.target!==el('targetUser').value||token.targetGeneration!==targetGeneration)))throw new Error('Operazione annullata: account o destinatario cambiato');
 if(!permitted())throw new Error('Verifica l’accesso amministratore prima di continuare');
}
const message=text=>{el('adminMessage').textContent=text;};
function requestId(key){if(!requests.has(key))requests.set(key,crypto.randomUUID());return requests.get(key);}
function completeConfirmation(accepted=false){
 const pending=confirmation;confirmation=null;el('adminConfirm').hidden=true;
 if(pending&&!accepted)message('Operazione annullata.');
 let valid=false;if(pending&&accepted){try{assertContext(pending.token);valid=!pending.fingerprint||pending.fingerprint()===pending.before;}catch{}}
 if(pending&&accepted&&!valid)message('Operazione annullata: account, destinatario o campi modificati durante la conferma.');
 if(pending)pending.resolve(valid);
}
function confirmAdmin(text,label='Conferma',fingerprint=null,token=contextToken()){
 completeConfirmation(false);
 return new Promise(resolve=>{confirmation={resolve,token,fingerprint,before:fingerprint?.()};el('adminConfirmText').textContent=text;el('adminConfirmAccept').textContent=label;el('adminConfirm').hidden=false;el('adminConfirmAccept').focus();});
}
el('adminConfirmAccept').addEventListener('click',()=>completeConfirmation(true));
el('adminConfirmCancel').addEventListener('click',()=>completeConfirmation(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&confirmation)completeConfirmation(false);});
function setVisibility(){
 el('adminLogin').hidden=!!session;el('logoutAdmin').hidden=!session;el('adminTools').hidden=!permitted();
 el('adminIdentity').textContent=session?'Account: '+session.user.email:'Accesso amministratore richiesto.';
 if(!permitted())completeConfirmation(false);
}
function selectedUser(){const user=userCache.get(el('targetUser').value);if(!user)throw new Error('Seleziona l’account destinatario');return user;}
function setBusy(value){
 busy=value;for(const node of document.querySelectorAll('#adminTools button,#adminTools input,#adminTools select'))node.disabled=value;
 const target=userCache.get(el('targetUser').value),protectedUser=!target||!!target.is_admin;
 for(const id of ['saveExpiry','saveStatus','targetStatus','noExpiry','previewContract','saveContract'])el(id).disabled=value||protectedUser;
 for(const [key] of PRODUCT_MODULES)el('module-'+key).disabled=value||protectedUser;
 el('targetExpiry').disabled=value||protectedUser||el('noExpiry').checked;
 el('contractStart').disabled=value||el('contractAction').value==='renew';
 el('installmentCount').disabled=value||el('paymentMode').value!=='installments';
 el('planInstallments').disabled=value||el('planPaymentMode').value!=='installments';
 el('assignCourseId').disabled=value||el('assignmentMode').value==='update';
 el('destinationCourse').disabled=value||el('assignmentMode').value!=='update';
 let valid=false;try{assignmentDraft();valid=true;}catch{}
 el('assignBank').disabled=value||!valid;
 el('saveContract').disabled=value||protectedUser||!contractPreview;
 el('previewRestore').disabled=value||!destinationSnapshot||!el('bankHistory').value;
 el('restoreBank').disabled=value||!restorePreview;
}
async function rpc(name,args={}){if(name==='quizlab_license'){const token=(await client.auth.getSession()).data?.session?.access_token;if(!token)throw Error('Accesso richiesto');const r=await fetch(globalThis.QUIZLAB_LAB_CONFIG.runtimeBase+'/license',{method:'POST',headers:{apikey:DEFAULT_CLOUD_CONFIG.supabasePublishableKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.message||'Verifica accesso non disponibile'),{status:r.status});return v;}
 const {data,error}=await client.rpc(name,args);
 if(error){const e=new Error(/forbidden|42501/i.test(error.message||'')?'È richiesto un account amministratore autorizzato.':error.message||'Operazione non riuscita');e.status=error.status;throw e;}return data;
}
async function run(action,{target=true}={}){
 if(busy)return;if(!permitted()){message('Verifica l’accesso amministratore prima di continuare.');setVisibility();return;}
 const token=contextToken({target});setBusy(true);
 try{await action(token);assertContext(token);}catch(error){message(error.message||String(error));}
 finally{if(token.generation===generation)setBusy(false);}
}
async function configureLicense(){await globalThis.UniSgiunglaLicense.configure({getUserId:()=>session?.user?.id||null,fetchLease:()=>rpc('quizlab_license')});await globalThis.UniSgiunglaLicense.refresh();}
function renderUsers(){
 el('adminUsers').innerHTML=renderAdminUserList(userList,{selfId:session?.user?.id,plans,actionsHtml:user=>'<button class="btn compact-btn" data-action="console-open-account" data-user="'+esc(user.user_id)+'">Licenza, piano e materie</button>'});
 const summary=userList.data.summary||{};
 el('adminTotals').textContent='Totali: '+Number(summary.total||0)+' account · '+Number(summary.pending||0)+' in attesa · '+Number(summary.active||0)+' attivi · '+Number(summary.suspended||0)+' sospesi · '+Number(summary.expired||0)+' scaduti · '+Number(summary.expiring_7d||0)+' in scadenza entro 7 giorni';
 const previous=el('targetUser').value;el('targetUser').replaceChildren(new Option('Seleziona un account',''));
 const choices=[...users];if(previous&&!choices.some(u=>u.user_id===previous)&&userCache.has(previous))choices.push(userCache.get(previous));
 for(const user of choices)el('targetUser').append(new Option(user.email||user.user_id,user.user_id));
 if(choices.some(user=>user.user_id===previous))el('targetUser').value=previous;
}
async function refreshUsers(){
 const token=contextToken({target:false}),page=userList.page;userList.loading=true;renderUsers();
 try{const data=await rpc('quizlab_admin_users_page',adminUserPageRequest(userList));assertContext(token);if(page!==userList.page)return;applyAdminUserPage(userList,data);users=userList.data.items;for(const user of users)userCache.set(user.user_id,user);}
 catch(error){if(token.generation!==generation||token.user!==(session?.user?.id||null))return;userList.loading=false;userList.error=error.message;throw error;}
 finally{if(token.generation===generation)renderUsers();}
}
async function expandUser(id,retry=false){
 const token=contextToken({target:false});
 if(userList.expanded.has(id)&&!retry){userList.expanded.delete(id);renderUsers();return;}
 userList.expanded.add(id);const existing=userList.details.get(id);if(existing?.data&&!retry){renderUsers();return;}
 userList.details.set(id,{loading:true});renderUsers();
 try{const detail=await rpc('quizlab_admin_user_detail',{target_user_id:id});assertContext(token);if(!userList.data.items.some(user=>user.user_id===id))return;userList.details.set(id,{loading:false,data:detail});}
 catch(error){if(token.generation===generation)userList.details.set(id,{loading:false,error:error.message});}
 if(token.generation===generation)renderUsers();
}
async function refreshAfterBankMutation(token){
 await refreshTarget();assertContext(token);const detail=targetDetail;
 // Reload the current filtered/sorted page, then replace any cached details
 // for the changed account using the same freshly fetched server snapshot.
 userList.details.delete(token.target);await refreshUsers();assertContext(token);
 if(userList.expanded.has(token.target)&&userList.data.items.some(user=>user.user_id===token.target)){
  userList.details.set(token.target,{loading:false,data:detail});renderUsers();
 }
}
async function openAccount(id){
 if(id!==selectedTargetId){targetGeneration++;selectedTargetId=id;completeConfirmation(false);targetDetail=null;destinationSnapshot=null;history=[];restorePreview=null;contractPreview=null;}
 if(!Array.from(el('targetUser').options||[]).some(option=>option.value===id))el('targetUser').append(new Option(userCache.get(id)?.email||id,id));
 el('targetUser').value=id;await refreshTarget();el('accountDetail').hidden=false;el('targetHeading').focus?.();
}
function selectTab(name){
 for(const node of document.querySelectorAll('[data-account-tab]')){const selected=node.dataset.accountTab===name;node.setAttribute('aria-selected',String(selected));}
 for(const node of document.querySelectorAll('[data-account-panel]'))node.hidden=node.dataset.accountPanel!==name;
}
function targetSummary(user){
 const approval=user.approval_status||user.account_status||'pending',status=adminEffectiveStatus(user);
 return 'Approvazione: '+statusLabel(approval)+' · Accesso effettivo: '+statusLabel(status)+' · Scadenza: '+dateLabel(user.expires_at)+(user.plan?' · '+user.plan.label:' · Senza piano')+(user.plan?.manual_override?' · Scadenza manuale modificata':'');
}
async function refreshTarget(){
 const id=el('targetUser').value;if(!id){el('accountDetail').hidden=true;return;}
 if(id!==selectedTargetId){targetGeneration++;selectedTargetId=id;completeConfirmation(false);destinationSnapshot=null;history=[];restorePreview=null;contractPreview=null;}
 const token=contextToken(),detail=await rpc('quizlab_admin_user_detail',{target_user_id:id});assertContext(token);
 targetDetail=detail;const user=detail.user||selectedUser();userCache.set(id,user);assignments=Array.isArray(detail.assignments)?detail.assignments:[];
 el('accountDetail').hidden=false;el('targetHeading').textContent=user.email||user.user_id;el('targetSummary').textContent=targetSummary(user);
 el('targetStatus').value=user.approval_status||(user.account_status==='expired'?'active':user.account_status)||'pending';
 fillUserModules(user);
 el('targetExpiry').value=dateInput(user.expires_at);el('noExpiry').checked=!user.expires_at;
 el('targetAccess').innerHTML=renderAdminUserDetails(user,detail)+'<p class="subtle">Ultima attività dispositivo: '+esc(dateLabel(user.last_seen))+'</p>';
 const before=el('destinationCourse').value;el('destinationCourse').replaceChildren(new Option('Seleziona la materia da aggiornare',''));el('targetAssignments').replaceChildren();
 for(const bank of assignments){const text=(bank.subject||bank.course_id)+' · '+bank.question_count+' domande · '+(bank.managed_by_admin?'Gestita':'Personale');el('destinationCourse').append(new Option(text,bank.course_id));const item=document.createElement('p');item.textContent=text;el('targetAssignments').append(item);}
 if(assignments.some(bank=>bank.course_id===before))el('destinationCourse').value=before;
 renderContracts();renderPlanChoices();restorePreview=null;
 if(el('assignmentMode').value==='update'&&el('destinationCourse').value)await loadDestination();else preview();setBusy(busy);
}
function showCandidates(rows){
 candidates=rows;sourceGeneration++;restorePreview=null;el('bankCandidate').replaceChildren(new Option('Seleziona la fonte delle domande',''));
 rows.forEach((row,index)=>el('bankCandidate').append(new Option(row.subject+' · '+bankCount(row.bank)+' domande · '+(row.provenance||'File JSON'),String(index))));
 // Loading a bank never changes the destination or silently chooses a source.
 el('bankCandidate').value='';preview();
}
function selectCandidate(){const row=currentSource();if(row&&el('assignmentMode').value==='create'&&!el('assignCourseId').value){el('assignCourseId').value=row.courseId;el('assignSubject').value=row.subject;}preview();}
function currentSource(){const value=el('bankCandidate').value;return /^\d+$/.test(value)?candidates[Number(value)]||null:null;}
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));return value;}
function bankDiff(before={},after={}){
 const a=new Map([...(before.officialBank||[]),...(before.aiBank||[])].map(row=>[row.id,row])),b=new Map([...(after.officialBank||[]),...(after.aiBank||[])].map(row=>[row.id,row]));
 const added=[...b.keys()].filter(id=>!a.has(id)),removed=[...a.keys()].filter(id=>!b.has(id)),changed=[...b.keys()].filter(id=>a.has(id)&&JSON.stringify(stable(a.get(id)))!==JSON.stringify(stable(b.get(id))));
 return{before:bankCount(before),after:bankCount(after),added,removed,changed,metadataChanged:JSON.stringify(stable({topicMap:before.topicMap??null,aiWorkflow:before.aiWorkflow||{}}))!==JSON.stringify(stable({topicMap:after.topicMap??null,aiWorkflow:after.aiWorkflow||{}}))};
}
function diffText(diff){return 'Prima: '+diff.before+' domande → Dopo: '+diff.after+' domande\nAggiunte: '+diff.added.length+' · Rimosse: '+diff.removed.length+' · Modificate: '+diff.changed.length+(diff.metadataChanged?'\nMappa o metadati di qualità diversi.':'');}
function diffHtml(diff){const ids=values=>esc(values.slice(0,200).join(', ')||'Nessuna')+(values.length>200?' · altre '+(values.length-200)+' identità':'');return '<p class="assignment-diff">'+esc(diffText(diff))+'</p><details class="admin-advanced"><summary>Identificativi del confronto</summary><p>Aggiunte: '+ids(diff.added)+'</p><p>Rimosse: '+ids(diff.removed)+'</p><p>Modificate: '+ids(diff.changed)+'</p></details>';}
function assignmentFingerprint(){return JSON.stringify([el('targetUser').value,el('assignmentMode').value,el('destinationCourse').value,el('assignCourseId').value,el('assignSubject').value,el('bankCandidate').value,sourceGeneration,destinationGeneration,destinationSnapshot?.revision||0]);}
function assignmentDraft(){
 const target=selectedUser(),source=currentSource();if(!source)throw new Error('Seleziona esplicitamente la fonte delle domande.');
 const mode=el('assignmentMode').value;if(!['create','update'].includes(mode))throw new Error('Scegli creazione o aggiornamento.');
 const id=courseId(mode==='update'?el('destinationCourse').value:el('assignCourseId').value),existing=assignments.find(bank=>bank.course_id===id);
 if(mode==='create'&&existing)throw new Error('Questo account possiede già la materia: scegli Aggiorna una materia esistente.');
 if(mode==='update'){
  if(!existing||destinationSnapshot?.course_id!==id||destinationSnapshot?.user_id!==target.user_id)throw new Error('Seleziona la destinazione e attendi il caricamento della banca corrente.');
  if(source.courseId!==id)throw new Error('Aggiornamento bloccato: la fonte “'+source.subject+'” appartiene a una materia diversa dalla destinazione “'+(existing.subject||id)+'”.');
 }
 const subject=cleanText(el('assignSubject').value||(existing?.subject)||source.subject||id),bank=normalizeAdminBank(source.bank);if(bank.topicMap)bank.topicMap.course={courseId:id,subject};
 const before=mode==='update'?normalizeAdminBank(destinationSnapshot.bank_json,true):{officialBank:[],aiBank:[],topicMap:null,aiWorkflow:{}};
 return{target,source,mode,id,subject,bank,revision:mode==='update'?Number(destinationSnapshot.revision):0,diff:bankDiff(before,bank)};
}
function preview(){
 const source=currentSource();el('bankPreview').textContent=source?'Fonte: '+source.subject+' · '+bankCount(source.bank)+' domande ('+source.bank.officialBank.length+' ufficiali, '+source.bank.aiBank.length+' AI) · '+(source.provenance||'File JSON'):'Seleziona la fonte: le materie del destinatario non cambiano questa scelta.';
 el('sourceIdentity').textContent=source?'Identificativo fonte: '+source.courseId:'Nessuna fonte selezionata';
 el('assignmentComparison').replaceChildren();el('assignmentWarning').textContent='';
 try{const draft=assignmentDraft();el('assignmentComparison').innerHTML=diffHtml(draft.diff);el('assignmentWarning').textContent='Destinatario: '+(draft.target.email||draft.target.user_id)+' · '+(draft.mode==='create'?'Nuova materia':'Aggiornamento')+' · '+draft.subject+(draft.mode==='update'?' · revisione '+draft.revision:'')+'. I progressi personali restano conservati.';}
 catch(error){el('assignmentWarning').textContent=error.message;}setBusy(busy);
}
async function loadDestination(){
 const id=el('destinationCourse').value;destinationSnapshot=null;history=[];restorePreview=null;destinationGeneration++;const dg=destinationGeneration;
 el('bankHistory').replaceChildren(new Option('Seleziona una revisione precedente',''));el('restoreComparison').replaceChildren();
 if(!id){preview();return;}const target=selectedUser(),token=contextToken();
 const [snapshot,h]=await Promise.all([rpc('quizlab_admin_bank_snapshot',{target_user_id:target.user_id,target_course_id:id}),rpc('quizlab_admin_bank_history',{target_user_id:target.user_id,target_course_id:id,limit_count:20})]);
 assertContext(token);if(dg!==destinationGeneration||el('destinationCourse').value!==id)return;
 if(!snapshot||snapshot.user_id!==target.user_id||snapshot.course_id!==id)throw new Error('Banca destinatario non disponibile');
 destinationSnapshot=snapshot;history=Array.isArray(h?.items)?h.items:[];el('assignCourseId').value=id;el('assignSubject').value=snapshot.subject||id;
 for(const row of history)el('bankHistory').append(new Option('Revisione '+row.revision+' · '+((row.official_count||0)+(row.ai_count||0))+' domande · '+dateLabel(row.archived_at),row.history_id));
 el('historySummary').textContent='Revisione corrente '+snapshot.revision+' · '+Number(h?.total||0)+' revisioni precedenti. Nessun ripristino automatico.';preview();
}
async function loadMyBanks(token){
 const uid=session.user.id,local=await readUserCourses(uid);assertContext(token);
 const rows=Object.entries(local||{}).filter(([,bank])=>bankCount(bank)>0).map(([id,bank])=>({courseId:courseId(id),subject:cleanText(bank.subject||id),bank:normalizeAdminBank(bank),provenance:'Locale · questo account'}));
 if(navigator.onLine){
  try{const {data,error}=await client.from('quizlab_banks').select('course_id,subject,bank_json,bank_revision,updated_at').eq('owner_id',uid);if(error)throw error;assertContext(token);for(const row of data||[])if(bankCount(row.bank_json))rows.push({courseId:courseId(row.course_id),subject:cleanText(row.subject||row.course_id),bank:normalizeAdminBank(row.bank_json),provenance:'Cloud · revisione '+Number(row.bank_revision||0)});}
  catch(error){assertContext(token);message('Fonte locale caricata. La copia cloud non è disponibile: '+error.message);}
 }
 assertContext(token);showCandidates(rows);message(rows.length+' fonti caricate in sola lettura. Locale e cloud restano varianti separate. Per dati solo nell’estensione desktop, sincronizza o importa il suo backup.');
}
function invalidateContract(){contractPreview=null;el('contractPreview').replaceChildren();el('saveContract').disabled=true;}
function contractFingerprint(){return JSON.stringify([el('targetUser').value,el('planPicker').value,el('contractAction').value,el('contractStart').value,el('paymentMode').value,el('installmentCount').value]);}
function contractArgs(){
 const target=selectedUser(),plan=plans.find(row=>row.plan_id===el('planPicker').value&&row.active);if(!plan)throw new Error('Seleziona un piano attivo.');
 if(JSON.stringify(stable(readModuleOverrides()))!==JSON.stringify(stable(target.module_overrides||{})))throw new Error('Prima salva o annulla le modifiche agli strumenti nella scheda Licenza.');
 const action=el('contractAction').value;if(!['activate','renew'].includes(action))throw new Error('Operazione piano non valida.');
 const payment=el('paymentMode').value;if(!['full','installments'].includes(payment))throw new Error('Modalità pagamento non valida.');
 const count=payment==='full'?1:Number(el('installmentCount').value);if(!Number.isInteger(count)||count<1||count>Number(plan.duration_months))throw new Error('Numero rate non valido: massimo una rata per mese del piano.');if(target.is_admin)throw new Error('Licenza amministratore protetta.');
 return{target_user_id:target.user_id,plan_id:plan.plan_id,action,starts_at:action==='renew'?null:(el('contractStart').value?expiryUtc(el('contractStart').value):null),payment_mode:payment,installment_count:count};
}
function renderPlanChoices(){const selected=el('planPicker').value;el('planPicker').replaceChildren(new Option('Seleziona un piano',''));for(const plan of plans.filter(row=>row.active))el('planPicker').append(new Option(plan.label+' · '+plan.duration_months+' mesi · '+money(plan.total_cents,plan.currency),plan.plan_id));if(plans.some(row=>row.plan_id===selected&&row.active))el('planPicker').value=selected;}
function renderPlans(){
 const before=el('catalogPlan').value;el('catalogPlan').replaceChildren(new Option('Crea un nuovo piano',''));for(const plan of plans)el('catalogPlan').append(new Option(plan.label+' · '+plan.duration_months+' mesi'+(plan.active?'':' · Disattivato'),plan.plan_id));if(plans.some(row=>row.plan_id===before))el('catalogPlan').value=before;
 el('planCatalogSummary').textContent=plans.length+' piani. Durata e modalità di pagamento sono indipendenti; non vengono effettuati addebiti.';renderPlanChoices();renderUsers();
}
async function loadPlans(){const token=contextToken({target:false});const data=await rpc('quizlab_admin_list_plans');assertContext(token);plans=Array.isArray(data)?data:[];renderPlans();}
function selectCatalog(){
 const plan=plans.find(row=>row.plan_id===el('catalogPlan').value);el('planId').value=plan?.plan_id||'';el('planId').readOnly=!!plan;el('planLabel').value=plan?.label||'';el('planDuration').value=String(plan?.duration_months||1);el('planCurrency').value=plan?.currency||'EUR';el('planAmount').value=plan?(Number(plan.total_cents||0)/100).toFixed(2):'';el('planPaymentMode').value=plan?.payment_mode||'full';el('planInstallments').value=String(plan?.installment_count||1);el('planActive').checked=plan?.active!==false;
 const flags=moduleFlags(plan?.modules);for(const [key] of PRODUCT_MODULES)el('plan-module-'+key).checked=flags[key];setBusy(busy);
}
function centsInput(value){const text=cleanText(value);if(!/^\d{1,8}([.,]\d{1,2})?$/.test(text))throw new Error('Inserisci un importo non negativo, con massimo due decimali.');const [whole,fraction='']=text.replace(',','.').split('.'),cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(!Number.isSafeInteger(cents)||cents>1000000000)throw new Error('Importo non valido');return cents;}
function planDraft(){
 const id=cleanText(el('planId').value),label=cleanText(el('planLabel').value),months=Number(el('planDuration').value),currency=cleanText(el('planCurrency').value).toUpperCase(),mode=el('planPaymentMode').value,count=mode==='full'?1:Number(el('planInstallments').value);
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(id)||reserved(id)||!label||label.length>120)throw new Error('Identificativo o nome piano non validi.');
 if(!Number.isInteger(months)||months<1||months>120||currency!=='EUR'||!['full','installments'].includes(mode)||!Number.isInteger(count)||count<1||count>months)throw new Error('Durata, valuta o rate non valide: EUR e massimo una rata per mese.');
 return{plan_id:id,label,duration_months:months,currency,total_cents:centsInput(el('planAmount').value),payment_mode:mode,installment_count:count,active:el('planActive').checked,modules:Object.fromEntries(PRODUCT_MODULES.map(([key])=>[key,!!el('plan-module-'+key).checked])),expected_version:Number(plans.find(row=>row.plan_id===id)?.version||0)};
}
function renderContractPreview(data){
 const plan=data.plan_snapshot,installments=data.installments||[];if(installments.reduce((sum,row)=>sum+Number(row.amount_cents),0)!==Number(plan.total_cents))throw new Error('Totale rate non coerente con il prezzo del piano.');
 return '<p><strong>'+esc(plan.label)+'</strong> · '+Number(plan.duration_months)+' mesi · '+esc(money(plan.total_cents,plan.currency))+'</p><p>Dal '+esc(dateLabel(data.starts_at))+' al '+esc(dateLabel(data.ends_at))+'</p><p><strong>Strumenti del piano:</strong> '+esc(moduleNames(plan.modules))+'</p><p><strong>Strumenti effettivi per questo utente:</strong> '+esc(moduleNames(data.modules||plan.modules))+'</p><p>'+esc(plan.payment_mode==='installments'?installments.length+' rate':'Pagamento unico')+'. La scadenza dipende dalla durata, non dalla singola rata.</p><details><summary>Calendario '+installments.length+' scadenze</summary>'+installments.map(row=>'<p>Rata '+row.number+' · '+esc(dateLabel(row.due_at))+' · '+esc(money(row.amount_cents,row.currency||plan.currency))+'</p>').join('')+'</details><p class="subtle">Anteprima amministrativa. Nessun addebito e nessuna sospensione automatica per rate.</p>';
}
function renderContracts(){
 const contracts=targetDetail?.contracts||[];
 el('targetContracts').innerHTML=contracts.map(contract=>'<article class="contract-card"><strong>'+esc(contract.plan_snapshot?.label||'Piano')+'</strong><p>'+esc(dateLabel(contract.starts_at))+' → '+esc(dateLabel(contract.ends_at))+(contract.manual_override?' · Scadenza modificata manualmente':'')+'</p><details><summary>Rate e registrazioni ('+(contract.installments||[]).length+')</summary>'+(contract.installments||[]).map(rate=>'<div class="installment-row"><span>Rata '+rate.number+' · '+esc(dateLabel(rate.due_at))+' · '+esc(money(rate.amount_cents,rate.currency))+' · '+(rate.status==='paid'?'Registrata pagata':'Da registrare')+'</span><button class="btn secondary compact-btn" data-action="rate-status" data-rate="'+esc(rate.installment_id)+'" data-status="'+(rate.status==='paid'?'scheduled':'paid')+'">'+(rate.status==='paid'?'Annulla registrazione':'Registra pagata')+'</button></div>').join('')+'</details></article>').join('')||'<p class="subtle">Nessun piano attivato per questo account.</p>';
}
async function bootstrap(){
 const token=contextToken({target:false});
 try{
  if(!session){isAdmin=false;users=[];candidates=[];setVisibility();return;}
  await configureLicense();if(token.generation!==generation)return;
  if(!globalThis.UniSgiunglaLicense.canUseFeatures())throw new Error('Licenza scaduta, sospesa o verifica locale non disponibile.');
  const admin=await rpc('quizlab_is_admin');if(token.generation!==generation||token.user!==session?.user?.id)return;isAdmin=admin===true;if(!permitted())throw new Error('Accesso riservato a un amministratore con licenza valida');
  setVisibility();await Promise.all([refreshUsers(),loadPlans()]);assertContext(token);
  const linked=new URL(location.href).searchParams.get('user');if(linked&&!selectedTargetId){userCache.set(linked,{user_id:linked});await openAccount(linked);}
  else if(el('targetUser').value)await refreshTarget();selectCatalog();message('Amministrazione locale pronta.');
 }catch(error){if(token.generation!==generation||token.user!==(session?.user?.id||null))return;isAdmin=false;setVisibility();message(error.message||String(error));}
}
async function initialize(){
 if(location.origin!=='https://sgiungla.github.io'||DEFAULT_CLOUD_CONFIG.supabaseUrl!=="https://eqrcdvhhfrkpmnzqoerr.supabase.co")throw new Error('Console amministrativa: origine non valida');
 client=globalThis.supabase.createClient(DEFAULT_CLOUD_CONFIG.supabaseUrl,DEFAULT_CLOUD_CONFIG.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,storage:adminAuthStorage()}});
 const {data,error}=await client.auth.getSession();if(error)throw error;session=data.session;
 client.auth.onAuthStateChange((event,value)=>{
  if(adminSignedOutLocally&&value)return;
  if((session?.user?.id||null)!==(value?.user?.id||null)||event==='SIGNED_OUT'){
   generation++;targetGeneration++;sourceGeneration++;destinationGeneration++;busy=false;isAdmin=false;completeConfirmation(false);
   userCache.clear();Object.assign(userList,createAdminUserListState());users=[];assignments=[];selectedTargetId='';targetDetail=null;destinationSnapshot=null;contractPreview=null;restorePreview=null;candidates=[];
   el('accountDetail').hidden=true;el('targetUser').replaceChildren(new Option('Seleziona un account',''));el('bankCandidate').replaceChildren(new Option('Seleziona la fonte delle domande',''));el('bankPreview').textContent='Nessuna fonte selezionata.';renderUsers();
  }
  session=value;setVisibility();setTimeout(()=>bootstrap(),0);
 });await bootstrap();
}
async function loginAdmin(){
 const intent=++adminAuthIntentGeneration;
 const credentials={email:cleanText(el('adminEmail').value),password:el('adminPassword').value};
 try{await enqueueAdminAuth(async()=>{if(intent!==adminAuthIntentGeneration)return;clearAdminAuthStorage();forgetAdminLocalIdentity();adminSignedOutLocally=false;const {error}=await client.auth.signInWithPassword(credentials);if(intent!==adminAuthIntentGeneration)return;if(error)throw error;el('adminPassword').value='';});}
 catch(error){if(intent===adminAuthIntentGeneration)message(error.message||String(error));}
}
async function logoutAdmin(){
 const intent=++adminAuthIntentGeneration;adminSignedOutLocally=true;
 generation++;targetGeneration++;sourceGeneration++;destinationGeneration++;busy=false;isAdmin=false;session=null;
 forgetAdminLocalIdentity();completeConfirmation(false);setVisibility();
 // Rebind immediately: an SDK refresh failure must not leave the previous signed lease usable by the console.
 globalThis.UniSgiunglaLicense?.configure({getUserId:()=>session?.user?.id||null,fetchLease:()=>rpc('quizlab_license')}).catch(()=>{});
 try{await enqueueAdminAuth(async()=>{const {error}=await client.auth.signOut({scope:'local'});if(error&&intent===adminAuthIntentGeneration)message('Uscita completata su questo dispositivo. '+(error.message||'Cloud non disponibile.'));});}
 catch(error){if(intent===adminAuthIntentGeneration)message('Uscita completata su questo dispositivo. '+(error.message||'Cloud non disponibile.'));}
 finally{
  // A later explicit login owns its SDK keys. Never erase that session when an old logout finishes.
  if(intent===adminAuthIntentGeneration&&adminSignedOutLocally){clearAdminAuthStorage();forgetAdminLocalIdentity();session=null;isAdmin=false;setVisibility();}
 }
}
el('loginAdmin').addEventListener('click',loginAdmin);
el('logoutAdmin').addEventListener('click',logoutAdmin);
el('reloadAdmin').addEventListener('click',()=>bootstrap());
el('targetUser').addEventListener('change',()=>run(()=>openAccount(el('targetUser').value),{target:false}));
el('adminUsers').addEventListener('click',event=>{
 if(busy)return;const button=event.target.closest('[data-action]');if(!button)return;const a=button.dataset.action;
 if(a==='console-open-account')return run(()=>openAccount(button.dataset.user),{target:false});
 if(a==='admin-users-detail'||a==='admin-users-detail-retry')return run(()=>expandUser(button.dataset.user,a.endsWith('-retry')),{target:false});
 if(a==='admin-users-filter'){updateAdminUserFilters(userList,readAdminUserFilters(document));return run(()=>refreshUsers(),{target:false});}
 if(a==='admin-users-reset'){resetAdminUserFilters(userList);return run(()=>refreshUsers(),{target:false});}
 if(a==='admin-users-previous'||a==='admin-users-next'){userList.page=Math.max(1,Math.min(Number(userList.data.total_pages)||1,userList.page+(a==='admin-users-next'?1:-1)));return run(()=>refreshUsers(),{target:false});}
});
for(const button of document.querySelectorAll('[data-account-tab]'))button.addEventListener('click',()=>selectTab(button.dataset.accountTab));
el('noExpiry').addEventListener('change',()=>setBusy(busy));
el('assignmentMode').addEventListener('change',()=>run(async()=>{restorePreview=null;if(el('assignmentMode').value==='update')await loadDestination();else preview();}));
el('destinationCourse').addEventListener('change',()=>run(()=>loadDestination()));
el('bankCandidate').addEventListener('change',selectCandidate);for(const id of ['assignCourseId','assignSubject'])el(id).addEventListener('input',preview);
el('bankHistory').addEventListener('change',()=>{restorePreview=null;el('restoreComparison').replaceChildren();setBusy(busy);});
el('adminBankFile').addEventListener('change',event=>run(async token=>{
 const file=event.target.files?.[0];if(!file)return;if(file.size>25*1024*1024)throw new Error('File troppo grande: massimo 25 MB');const contents=await file.text();assertContext(token);showCandidates(extractBankCandidates(JSON.parse(contents)).map(row=>({...row,provenance:'File JSON · '+file.name})));message('Fonti caricate. Seleziona la fonte e la destinazione; nessuna assegnazione automatica.');
}));
el('loadMyBanks').addEventListener('click',()=>run(token=>loadMyBanks(token)));
el('saveExpiry').addEventListener('click',()=>run(async token=>{
 const target=selectedUser();if(target.is_admin)throw new Error('Licenza amministratore protetta');const expiry=expiryUtc(el('targetExpiry').value,el('noExpiry').checked),fingerprint=()=>JSON.stringify([el('targetUser').value,el('targetExpiry').value,el('noExpiry').checked]);
 if(!await confirmAdmin('Account: '+(target.email||target.user_id)+'\nScadenza manuale: '+dateLabel(target.expires_at)+' → '+dateLabel(expiry)+'\nQuesta è una modifica manuale; non rinnova un piano. I dati vengono conservati.','Conferma scadenza',fingerprint,token))return;
 assertContext(token);await rpc('quizlab_admin_set_expiry',{target_user_id:target.user_id,target_expires_at:expiry});assertContext(token);await refreshTarget();await refreshUsers();message('Scadenza manuale salvata. Piano e registrazioni restano consultabili.');
}));
el('saveStatus').addEventListener('click',()=>run(async token=>{
 const target=selectedUser(),draft=userAccessDraft(),fingerprint=()=>JSON.stringify(userAccessDraft()),effective=previewUserModules();
 if(!await confirmAdmin('Account: '+(target.email||target.user_id)+'\nApprovazione: '+statusLabel(draft.approval_status)+'\nStrumenti: '+moduleNames(effective)+'\nApprovazione e strumenti vengono salvati insieme. La scadenza non cambia e i dati vengono conservati.','Conferma approvazione e strumenti',fingerprint,token))return;
 const out=await rpc('quizlab_admin_save_user_access',{...draft,request_id:requestId('access:'+JSON.stringify(draft))});assertContext(token);
 if(out?.conflict)throw new Error('La licenza è cambiata: aggiorna la scheda e verifica di nuovo gli strumenti.');if(!out?.ok)throw new Error('Approvazione e strumenti non confermati');
 await refreshTarget();await refreshUsers();invalidateContract();message('Approvazione e strumenti salvati insieme. Una licenza scaduta richiede rinnovo o modifica della scadenza.');
}));
for(const [key] of PRODUCT_MODULES)el('module-'+key).addEventListener('change',()=>{completeConfirmation(false);previewUserModules();});
el('assignBank').addEventListener('click',()=>run(async token=>{
 const draft=assignmentDraft(),fingerprint=assignmentFingerprint,key='assign:'+JSON.stringify([draft.target.user_id,draft.mode,draft.id,draft.revision,draft.source.courseId,draft.bank,draft.subject]);
 if(!await confirmAdmin('Fonte: '+draft.source.subject+' · '+bankCount(draft.bank)+' domande · '+(draft.source.provenance||'File JSON')+'\nDestinatario: '+(draft.target.email||draft.target.user_id)+'\nOperazione: '+(draft.mode==='create'?'Crea nuova materia':'Aggiorna materia esistente')+'\nMateria destinazione: '+draft.subject+'\n'+diffText(draft.diff)+'\nRevisione precedente: '+draft.revision+'\nI suoi progressi non verranno sostituiti.','Conferma assegnazione',fingerprint,token))return;
 assertContext(token);const out=await rpc('quizlab_admin_assign_course_safe',{target_user_id:draft.target.user_id,target_course_id:draft.id,target_subject:draft.subject,incoming_bank:draft.bank,expected_revision:draft.revision,operation_mode:draft.mode,source_course_id:draft.source.courseId,request_id:requestId(key)});
 assertContext(token);if(out?.conflict)throw new Error('La materia è cambiata nel frattempo o l’identificativo è occupato: aggiorna e verifica di nuovo.');if(!out?.ok)throw new Error('Assegnazione non confermata dal database');await refreshAfterBankMutation(token);message('Materia assegnata a '+(draft.target.email||draft.target.user_id)+'. Progressi personali conservati.');
}));
el('previewRestore').addEventListener('click',()=>run(async token=>{
 const id=el('bankHistory').value,snapshot=destinationSnapshot;if(!snapshot||!id)throw new Error('Seleziona una versione precedente.');const stored=await rpc('quizlab_admin_history_bank',{history_id:id});assertContext(token);
 if(stored.user_id!==token.target||stored.course_id!==snapshot.course_id||el('bankHistory').value!==id)throw new Error('La versione non appartiene alla destinazione selezionata.');
 restorePreview={history:stored,current:snapshot,diff:bankDiff(normalizeAdminBank(snapshot.bank_json,true),normalizeAdminBank(stored.bank_json,true)),fingerprint:assignmentFingerprint(),historyId:id};el('restoreComparison').innerHTML='<strong>Ripristino revisione '+stored.revision+'</strong>'+diffHtml(restorePreview.diff)+'<p>I progressi personali non vengono ripristinati né azzerati.</p>';setBusy(busy);
}));
el('restoreBank').addEventListener('click',()=>run(async token=>{
 const p=restorePreview,target=selectedUser();if(!p||p.fingerprint!==assignmentFingerprint()||p.historyId!==el('bankHistory').value)throw new Error('Ricalcola l’anteprima del ripristino.');const fingerprint=()=>JSON.stringify([assignmentFingerprint(),el('bankHistory').value]);
 if(!await confirmAdmin('Destinatario: '+(target.email||target.user_id)+'\nRipristina '+(p.history.subject||p.current.subject)+' dalla revisione '+p.history.revision+'\n'+diffText(p.diff)+'\nRevisione corrente: '+p.current.revision+'\nI progressi personali restano conservati.','Conferma ripristino banca',fingerprint,token))return;
 const key='restore:'+JSON.stringify([target.user_id,p.current.course_id,p.historyId,p.current.revision]),out=await rpc('quizlab_admin_restore_bank',{target_user_id:target.user_id,target_course_id:p.current.course_id,history_id:p.historyId,expected_revision:Number(p.current.revision),request_id:requestId(key)});assertContext(token);
 if(out?.conflict)throw new Error('La banca è cambiata: aggiorna e ricalcola il ripristino.');if(!out?.ok)throw new Error('Ripristino non confermato');await refreshAfterBankMutation(token);message('Banca ripristinata con nuova revisione. Progressi personali conservati.');
}));
for(const id of ['planPicker','contractAction','contractStart','paymentMode','installmentCount'])el(id).addEventListener('change',()=>{
 invalidateContract();if(id==='planPicker'){const plan=plans.find(row=>row.plan_id===el(id).value);el('paymentMode').value=plan?.payment_mode||'full';el('installmentCount').value=String(plan?.installment_count||1);}if(el('contractAction').value==='renew')el('contractStart').value='';setBusy(busy);
});
el('previewContract').addEventListener('click',()=>run(async token=>{
 const args=contractArgs(),fingerprint=contractFingerprint(),data=await rpc('quizlab_admin_preview_contract',args);assertContext(token);if(fingerprint!==contractFingerprint())throw new Error('I campi del piano sono cambiati: ricalcola l’anteprima.');
 if(data.user_id!==args.target_user_id||data.action!==args.action||!data.plan_snapshot?.version||!Number.isFinite(Number(data.license_revision)))throw new Error('Anteprima server non valida');
 const html=renderContractPreview(data);contractPreview={args,data,fingerprint,request_id:requestId('contract:'+JSON.stringify([args,data.license_revision,data.plan_snapshot.version,data.starts_at,data.ends_at]))};el('contractPreview').innerHTML=html;setBusy(busy);
}));
el('saveContract').addEventListener('click',()=>run(async token=>{
 const p=contractPreview,target=selectedUser();if(!p||p.fingerprint!==contractFingerprint())throw new Error('Ricalcola l’anteprima del piano.');const plan=p.data.plan_snapshot;
 if(!await confirmAdmin('Account: '+(target.email||target.user_id)+'\nOperazione: '+(p.args.action==='renew'?'Rinnovo':'Attivazione')+'\nPiano: '+plan.label+' · '+plan.duration_months+' mesi\nDal '+dateLabel(p.data.starts_at)+' al '+dateLabel(p.data.ends_at)+'\nTotale: '+money(plan.total_cents,plan.currency)+' · '+(plan.payment_mode==='installments'?p.data.installments.length+' rate':'Pagamento unico')+'\nStrumenti del piano: '+moduleNames(plan.modules)+'\nStrumenti effettivi: '+moduleNames(p.data.modules||plan.modules)+'\nNessun addebito automatico. I dati personali sono conservati.','Conferma piano',contractFingerprint,token))return;
 const args={...p.args,starts_at:p.args.action==='activate'?p.data.starts_at:null,preview_starts_at:p.args.action==='renew'?p.data.starts_at:null,request_id:p.request_id,expected_license_revision:Number(p.data.license_revision),expected_plan_version:Number(plan.version)},out=await rpc('quizlab_admin_save_contract',args);assertContext(token);
 if(out?.conflict)throw new Error('Piano o licenza modificati nel frattempo: ricalcola l’anteprima.');if(!out?.ok)throw new Error('Piano non confermato');invalidateContract();await refreshTarget();await refreshUsers();message('Piano '+(p.args.action==='renew'?'rinnovato':'attivato')+'. Scadenza impostata dal server.');
}));
el('catalogPlan').addEventListener('change',selectCatalog);el('planPaymentMode').addEventListener('change',()=>setBusy(busy));
el('savePlan').addEventListener('click',()=>run(async token=>{
 const draft=planDraft(),fingerprint=()=>JSON.stringify(planDraft());
 if(!await confirmAdmin('Piano: '+draft.label+'\nDurata: '+draft.duration_months+' mesi\nTotale: '+money(draft.total_cents,draft.currency)+'\n'+(draft.payment_mode==='installments'?draft.installment_count+' rate':'Pagamento unico')+'\nStrumenti: '+moduleNames(draft.modules)+'\n'+(draft.active?'Disponibile per nuove attivazioni':'Disattivato per nuove attivazioni')+'\nI contratti già attivati mantengono il proprio piano registrato.','Conferma piano catalogo',fingerprint,token))return;
 const out=await rpc('quizlab_admin_save_plan',{...draft,request_id:requestId('plan:'+JSON.stringify(draft))});assertContext(token);if(out?.conflict)throw new Error('Il piano è cambiato: aggiorna il catalogo.');if(!out?.ok)throw new Error('Piano non salvato');await loadPlans();invalidateContract();message('Catalogo aggiornato. Nessun contratto esistente è stato sostituito.');
},{target:false}));
el('targetContracts').addEventListener('click',event=>{
 const button=event.target.closest('[data-action="rate-status"]');if(!button)return;
 return run(async token=>{
  const target=selectedUser(),rate=(targetDetail?.contracts||[]).flatMap(contract=>contract.installments||[]).find(item=>item.installment_id===button.dataset.rate),status=button.dataset.status;
  if(!rate||!['paid','scheduled'].includes(status))throw new Error('Rata non disponibile');
  if(!await confirmAdmin('Account: '+(target.email||target.user_id)+'\nRata '+rate.number+' · '+money(rate.amount_cents,rate.currency)+' · '+dateLabel(rate.due_at)+'\n'+(status==='paid'?'Registra manualmente come pagata':'Annulla la registrazione di pagamento')+'\nNessun addebito e nessuna modifica automatica della licenza.','Conferma registrazione rata',null,token))return;
  const out=await rpc('quizlab_admin_set_installment_status',{installment_id:rate.installment_id,status,request_id:requestId('rate:'+JSON.stringify([rate.installment_id,rate.status,status,rate.paid_at]))});assertContext(token);if(!out?.ok)throw new Error('Registrazione non confermata');await refreshTarget();message('Registrazione rata aggiornata. La scadenza del piano non cambia.');
 });
});
window.addEventListener('unisgiungla-license-change',()=>{if(!permitted())completeConfirmation(false);setVisibility();});
initialize().catch(error=>message(error.message||String(error)));
