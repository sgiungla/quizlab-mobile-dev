const DB_NAME = 'quizlab-mobile-dev';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'quizlab';
let activeWorkspaceKey='guest';

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

function mergeWorkspace(a,b){
  const x=shapeStore(a),y=shapeStore(b),out=shapeStore(x);
  out.courses={...(x.courses||{})};
  for(const [id,c] of Object.entries(y.courses||{})){
    const prev=out.courses[id];
    const pt=String(prev?.updatedAt||prev?.createdAt||'');
    const nt=String(c?.updatedAt||c?.createdAt||'');
    if(!prev||nt>=pt) out.courses[id]=c;
  }
  out.updatedAt=new Date().toISOString();
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
  if(userId&&importGuest)c.workspaces[key]=mergeWorkspace(c.workspaces[key],c.workspaces.guest);
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
  const store=shapeStore(input);
  store.updatedAt=new Date().toISOString();
  const c=shapeContainer(await readRaw());
  c.workspaces[activeWorkspaceKey]=store;
  if(activeWorkspaceKey==='guest')c.meta.guestDirtyAt=store.updatedAt;
  await writeRaw(c);
  return store;
}
