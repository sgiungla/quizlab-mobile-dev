import {QuizLabSyncAdapter} from './sync-adapter.js';

const DB_NAME = 'quizlab-mobile-dev';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'quizlab';
let activeWorkspaceKey='guest';
const mergeHelper=new QuizLabSyncAdapter();
let writeChain=Promise.resolve();

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
    });
  }catch(e){
    const raw=localStorage.getItem('quizlab-mobile-fallback');
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
    });
  }catch(e){
    localStorage.setItem('quizlab-mobile-fallback',JSON.stringify(container));
  }
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
  let bankSource=aBankAt>bBankAt?a:bBankAt>aBankAt?b:null;
  if(!bankSource)bankSource=courseBankCount(b)>=courseBankCount(a)?b:a;
  const merged=mergeHelper.mergeProgress(mergeHelper.progressPayload(a),mergeHelper.progressPayload(b));
  const revisions=[a.cloudRevision,b.cloudRevision].filter(v=>v!==undefined&&v!==null).map(Number).filter(Number.isFinite);
  return shapeStore({courses:{x:{
    ...older,...newest,
    subject:bankSource.subject||newest.subject||older.subject||'',
    officialBank:Array.isArray(bankSource.officialBank)?bankSource.officialBank:[],
    aiBank:Array.isArray(bankSource.aiBank)?bankSource.aiBank:[],
    topicMap:bankSource.topicMap??null,
    aiWorkflow:bankSource.aiWorkflow||{},
    bankUpdatedAt:maxIso(aBankAt,bBankAt)||maxIso(aAt,bAt),
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
  const c=shapeContainer(await readRaw());
  const key=userId?'user:'+userId:'guest';
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
  activeWorkspaceKey=key;
  await writeRaw(c);
  return shapeStore(c.workspaces[key]);
}

export function currentWorkspaceKey(){return activeWorkspaceKey;}

export async function loadStore(){
  const c=shapeContainer(await readRaw());
  if(!c.workspaces[activeWorkspaceKey])c.workspaces[activeWorkspaceKey]=emptyStore();
  // Persist migration from the old single-store format.
  await writeRaw(c);
  return shapeStore(c.workspaces[activeWorkspaceKey]);
}

export async function saveStore(input){
  const requested=shapeStore(input);
  requested.updatedAt=new Date().toISOString();
  const operation=async()=>{
    const c=shapeContainer(await readRaw());
    const current=c.workspaces[activeWorkspaceKey]||emptyStore();
    const safe=mergeWorkspace(current,requested);
    // Respect explicit local/cloud removals represented by hiddenCourseIds.
    for(const id of requested.sync?.hiddenCourseIds||[]){
      if(!requested.courses?.[id])delete safe.courses[id];
    }
    c.workspaces[activeWorkspaceKey]=safe;
    if(activeWorkspaceKey==='guest')c.meta.guestDirtyAt=safe.updatedAt;
    await writeRaw(c);
    return safe;
  };
  writeChain=writeChain.then(operation,operation);
  return writeChain;
}
