const DB_NAME = 'quizlab-mobile-dev';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'quizlab';

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

export async function loadStore(){
  try{
    const db=await openDb();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const req=tx.objectStore(STORE).get(KEY);
      req.onsuccess=()=>resolve(shapeStore(req.result || emptyStore()));
      req.onerror=()=>reject(req.error);
    });
  }catch(e){
    const raw=localStorage.getItem('quizlab-mobile-fallback');
    return shapeStore(raw ? JSON.parse(raw) : emptyStore());
  }
}

export async function saveStore(input){
  const store=shapeStore(input);
  store.updatedAt=new Date().toISOString();
  try{
    const db=await openDb();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(store,KEY);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
    });
  }catch(e){
    localStorage.setItem('quizlab-mobile-fallback',JSON.stringify(store));
  }
  return store;
}
