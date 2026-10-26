import {QuizLabSyncAdapter} from './sync-adapter.js';

const DB_NAME = 'quizlab-mobile-dev';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'quizlab';
let activeWorkspaceKey='guest';
const mergeHelper=new QuizLabSyncAdapter();
let writeChain=Promise.resolve();
let workspaceGeneration=0;
const FALLBACK_KEY='quizlab-mobile-fallback';

function openDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}

function uid(){
  try{return crypto.randomUUID();}catch(e){return 'dev_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);}
}

export function emptyProfile(){
  return {
    localUserId:uid(),
    displayName:'',
    avatarDataUrl:'',
    motto:'La giungla universitaria è sotto controllo.',
    createdAt:new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
}

export function emptySyncState(){
  const clientId=uid();
  return {
    mode:'local-only',
    clientId,
    ownerId:'local:'+clientId,
    dirtyCourseIds:[],
    dirtyBankCourseIds:[],
    hiddenCourseIds:[],
    profileDirty:false,
    ackCourseChanges:{},
    ackBankChanges:{},
    lastLocalChangeAt:null,
    lastPushAt:null,
    lastPullAt:null
  };
}

export function emptyStore(){
  return {
    version:2,
    courses:{},
    profile:emptyProfile(),
    sync:emptySyncState(),
    settings:{},
    updatedAt:new Date().toISOString()
  };
}

export function shapeStore(input){
  const base=emptyStore();
  const store={...base,...(input||{})};
  store.version=2;
  if(!store.courses || typeof store.courses!=='object') store.courses={};
  if(!store.settings || typeof store.settings!=='object') store.settings={};
  store.profile={...base.profile,...(store.profile||{})};
  store.sync={...base.sync,...(store.sync||{})};
  if(!Array.isArray(store.sync.dirtyCourseIds)) store.sync.dirtyCourseIds=[];
  if(!Array.isArray(store.sync.dirtyBankCourseIds)) store.sync.dirtyBankCourseIds=[];
  if(!Array.isArray(store.sync.hiddenCourseIds)) store.sync.hiddenCourseIds=[];
  if(!store.sync.clientId) store.sync.clientId=uid();
  if(!store.sync.ownerId) store.sync.ownerId='local:'+store.sync.clientId;
  return store;
}

function emptyContainer(){
  return {version:3,workspaces:{guest:emptyStore()},meta:{guestDirtyAt:null,guestHandledByUser:{}},updatedAt:new Date().toISOString()};
}

function shapeContainer(raw){
  if(Number(raw?.version)>3)throw new Error('Schema locale più recente non supportato: dati conservati. Aggiorna QuizLab.');
  if(raw && Number(raw.version)>=3 && raw.workspaces && typeof raw.workspaces==='object'){
    const out={version:3,workspaces:{},meta:raw.meta&&typeof raw.meta==='object'?raw.meta:{},updatedAt:raw.updatedAt||new Date().toISOString()};
    for(const [key,value] of Object.entries(raw.workspaces)) out.workspaces[key]=shapeStore(value);
    if(!out.workspaces.guest) out.workspaces.guest=emptyStore();
    if(!out.meta.guestHandledByUser || typeof out.meta.guestHandledByUser!=='object') out.meta.guestHandledByUser={};
    return out;
  }
  const legacy=shapeStore(raw||emptyStore());
  return {
    version:3,
    workspaces:{guest:legacy},
    meta:{
      migratedLegacyAt:new Date().toISOString(),
      guestDirtyAt:Object.keys(legacy.courses||{}).length?(legacy.updatedAt||new Date().toISOString()):null,
      guestHandledByUser:{}
    },
    updatedAt:legacy.updatedAt||new Date().toISOString()
  };
}

async function readRaw(){
  try{
    const db=await openDb();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const req=tx.objectStore(STORE).get(KEY);
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(req.error);
      tx.onabort=()=>reject(tx.error||new Error('Lettura locale annullata'));
    });
  }catch(e){
    const raw=localStorage.getItem(FALLBACK_KEY);
    return raw?JSON.parse(raw):null;
  }
}

async function writeRaw(container){
  container.updatedAt=new Date().toISOString();
  try{
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(container,KEY);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error||new Error('Salvataggio locale annullato'));
    });
  }catch(e){
    localStorage.setItem(FALLBACK_KEY,JSON.stringify(container));
  }
}

// One readwrite transaction serializes read/merge/write across browser tabs.
// The Web Lock also protects the localStorage fallback in Chrome/Edge.
function updateContainer(transform){
  const operation=async()=>{
    let db=null;
    try{db=await openDb();}catch(error){}
    if(db)return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),objectStore=tx.objectStore(STORE);
      const request=objectStore.get(KEY);let result;
      request.onsuccess=()=>{
        try{
          const container=shapeContainer(request.result||null);
          result=transform(container);
          container.updatedAt=new Date().toISOString();
          objectStore.put(container,KEY);
        }catch(error){tx.abort();reject(error);}
      };
      tx.oncomplete=()=>{db.close?.();resolve(result);};
      tx.onerror=()=>{db.close?.();reject(tx.error);};
      tx.onabort=()=>{db.close?.();reject(tx.error||new Error('Salvataggio annullato'));};
    });
    if(!globalThis.navigator?.locks?.request)throw new Error('Salvataggio degradato non sicuro: usa Chrome/Edge con IndexedDB o Web Locks disponibili');
    const raw=localStorage.getItem(FALLBACK_KEY);
    const container=shapeContainer(raw?JSON.parse(raw):null);
    const result=transform(container);container.updatedAt=new Date().toISOString();
    localStorage.setItem(FALLBACK_KEY,JSON.stringify(container));
    return result;
  };
  const locked=()=>globalThis.navigator?.locks?.request?globalThis.navigator.locks.request('quizlab-local-lab-state',operation):operation();
  writeChain=writeChain.then(locked,locked);
  return writeChain;
}

function meaningful(store){
  return Object.values(store?.courses||{}).some(c=>c && !c.archived && ((c.officialBank?.length||0)||(c.aiBank?.length||0)||(c.attempts?.length||0)||(c.exams?.length||0)||c.topicMap));
}

function maxIso(a,b){
  if(!a)return b||'';
  if(!b)return a||'';
  return String(a)>=String(b)?a:b;
}

function courseBankCount(c={}){
  return (Array.isArray(c.officialBank)?c.officialBank.length:0)+(Array.isArray(c.aiBank)?c.aiBank.length:0);
}

function mergeCourseCopies(a,b){
  if(!a)return b;
  if(!b)return a;
  const aAt=String(a.updatedAt||a.createdAt||''),bAt=String(b.updatedAt||b.createdAt||'');
  const newest=bAt>=aAt?b:a,older=newest===b?a:b;
  const aBankAt=String(a.bankUpdatedAt||a.createdAt||a.updatedAt||'');
  const bBankAt=String(b.bankUpdatedAt||b.createdAt||b.updatedAt||'');
  const bankSource=aBankAt>bBankAt?a:b;
  const bankRevisions=[a.cloudBankRevision,b.cloudBankRevision].map(Number).filter(Number.isFinite);
  const cloudSource=Number(a.cloudBankRevision||0)>Number(b.cloudBankRevision||0)?a:b;
  const bank=cloudSource.managedByAdmin?mergeHelper.bankPayload(cloudSource):mergeHelper.mergeBanks(mergeHelper.bankPayload(a),mergeHelper.bankPayload(b));
  const merged=mergeHelper.mergeProgress(mergeHelper.progressPayload(a),mergeHelper.progressPayload(b));
  const revisions=[a.cloudRevision,b.cloudRevision].filter(v=>v!==undefined&&v!==null).map(Number).filter(Number.isFinite);
  return shapeStore({courses:{x:{
    ...older,...newest,
    subject:bankSource.subject||newest.subject||older.subject||'',
    officialBank:bank.officialBank,aiBank:bank.aiBank,topicMap:bank.topicMap,aiWorkflow:bank.aiWorkflow,
    bankMeta:bank.bankMeta,bankUpdatedAt:bank.updatedAt,
    cloudBankRevision:bankRevisions.length?Math.max(...bankRevisions):null,
    cloudBankBase:cloudSource.cloudBankBase||null,
    managedByAdmin:!!cloudSource.managedByAdmin,
    attempts:merged.attempts||[],
    exams:merged.exams||[],
    marked:merged.marked||[],
    pendingReview:merged.pendingReview||[],
    historicalWrong:merged.historicalWrong||[],
    fullCampaign:{...(merged.fullCampaign||{}),signature:newest.fullCampaign?.signature||bankSource.fullCampaign?.signature||older.fullCampaign?.signature||'all'},
    syncMeta:merged.syncMeta||newest.syncMeta||older.syncMeta||{},
    cloudRevision:revisions.length?Math.max(...revisions):null,
    updatedAt:maxIso(aAt,bAt)||new Date().toISOString()
  }}}).courses.x;
}

function mergeWorkspace(a,b){
  const x=shapeStore(a),y=shapeStore(b);
  const out=shapeStore({...x,...y,settings:{...(x.settings||{}),...(y.settings||{})}});
  out.courses={};
  const ids=new Set([...Object.keys(x.courses||{}),...Object.keys(y.courses||{})]);
  const hidden=new Set(y.sync?.hiddenCourseIds||[]);
  for(const id of ids){
    if(hidden.has(id)&&!y.courses?.[id])continue;
    out.courses[id]=mergeCourseCopies(x.courses?.[id]||null,y.courses?.[id]||null);
  }
  out.updatedAt=maxIso(x.updatedAt,y.updatedAt)||new Date().toISOString();
  const courseAck={...(x.sync.ackCourseChanges||{}),...(y.sync.ackCourseChanges||{})};
  const bankAck={...(x.sync.ackBankChanges||{}),...(y.sync.ackBankChanges||{})};
  const pending=new Set([...(x.sync.dirtyCourseIds||[]),...(y.sync.dirtyCourseIds||[])]);
  const bankPending=new Set([...(x.sync.dirtyBankCourseIds||[]),...(y.sync.dirtyBankCourseIds||[])]);
  for(const id of pending){
    if(!y.sync.dirtyCourseIds.includes(id)&&courseAck[id]&&courseAck[id]===out.courses[id]?.updatedAt)pending.delete(id);
  }
  for(const id of bankPending){
    if(!y.sync.dirtyBankCourseIds.includes(id)&&bankAck[id]&&out.courses[id]&&bankAck[id]===mergeHelper.bankHash(mergeHelper.bankPayload(out.courses[id])))bankPending.delete(id);
  }
  out.sync={...out.sync,dirtyCourseIds:[...pending],dirtyBankCourseIds:[...bankPending],ackCourseChanges:courseAck,ackBankChanges:bankAck};
  return out;
}

export async function workspaceMigrationInfo(userId){
  if(!userId)return {needsDecision:false};
  const c=shapeContainer(await readRaw());
  const dirty=c.meta?.guestDirtyAt||null;
  const handled=c.meta?.guestHandledByUser?.[userId]||null;
  return {
    needsDecision:meaningful(c.workspaces.guest)&&!!dirty&&String(dirty)>String(handled||''),
    guestDirtyAt:dirty,
    hasUserWorkspace:!!c.workspaces['user:'+userId]
  };
}

export async function selectWorkspace(userId,{importGuest=false,markGuestHandled=false}={}){
  const key=userId?'user:'+userId:'guest';
  activeWorkspaceKey=key;
  const generation=++workspaceGeneration;
  return updateContainer(c=>{
  if(!c.workspaces[key])c.workspaces[key]=emptyStore();
  if(userId&&importGuest){
    const guestIds=Object.keys(c.workspaces.guest?.courses||{});
    c.workspaces[key]=mergeWorkspace(c.workspaces[key],c.workspaces.guest);
    c.workspaces[key].sync.dirtyCourseIds=[...new Set([...(c.workspaces[key].sync.dirtyCourseIds||[]),...guestIds])];
    c.workspaces[key].sync.dirtyBankCourseIds=[...new Set([...(c.workspaces[key].sync.dirtyBankCourseIds||[]),...guestIds])];
    c.workspaces[key].sync.lastLocalChangeAt=new Date().toISOString();
  }
  if(userId&&markGuestHandled){
    c.meta.guestHandledByUser={...(c.meta.guestHandledByUser||{}),[userId]:c.meta.guestDirtyAt||new Date().toISOString()};
  }
  if(generation!==workspaceGeneration)throw new Error('Cambio account superato da una nuova richiesta');
  return shapeStore(c.workspaces[key]);
  });
}

export function currentWorkspaceKey(){return activeWorkspaceKey;}
export function currentWorkspaceGeneration(){return workspaceGeneration;}

// The admin bank picker can read this account's existing PWA courses without
// switching the active workspace, merging guest data or writing to storage.
export async function readUserCourses(userId){
  if(typeof userId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))throw new Error('Account locale non valido');
  const raw=await readRaw();
  const workspace=Number(raw?.version)>=3?raw.workspaces?.['user:'+userId]:null;
  return structuredClone(workspace?.courses&&typeof workspace.courses==='object'?workspace.courses:{});
}

export async function loadStore(){
  const key=activeWorkspaceKey;
  return updateContainer(c=>{
  if(!c.workspaces[key])c.workspaces[key]=emptyStore();
  // Persist migration from the old single-store format.
  return shapeStore(c.workspaces[key]);
  });
}

export async function saveStore(input){
  const workspaceKey=activeWorkspaceKey;
  const requested=shapeStore(structuredClone(input));
  if(requested.sync.ownerId&&!String(requested.sync.ownerId).startsWith('local:')&&workspaceKey!==('user:'+requested.sync.ownerId))throw new Error('Salvataggio annullato: workspace diverso dal proprietario');
  requested.updatedAt=new Date().toISOString();
  return updateContainer(c=>{
    const current=c.workspaces[workspaceKey]||emptyStore();
    const safe=mergeWorkspace(current,requested);
    // Respect explicit local/cloud removals represented by hiddenCourseIds.
    for(const id of requested.sync?.hiddenCourseIds||[]){
      if(!requested.courses?.[id])delete safe.courses[id];
    }
    c.workspaces[workspaceKey]=safe;
    if(workspaceKey==='guest')c.meta.guestDirtyAt=safe.updatedAt;
    return safe;
  });
}
