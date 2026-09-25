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

export function emptyStore(){
  return {version:1,courses:{},settings:{},updatedAt:new Date().toISOString()};
}

export async function loadStore(){
  try{
    const db=await openDb();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const req=tx.objectStore(STORE).get(KEY);
      req.onsuccess=()=>resolve(req.result || emptyStore());
      req.onerror=()=>reject(req.error);
    });
  }catch(e){
    const raw=localStorage.getItem('quizlab-mobile-fallback');
    return raw ? JSON.parse(raw) : emptyStore();
  }
}

export async function saveStore(store){
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
}
