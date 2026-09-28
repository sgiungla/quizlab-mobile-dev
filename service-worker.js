const CACHE='quizlab-mobile-dev-v0.10.7';
const ASSETS=['./','./index.html','./styles.css','./app.js','./db.js','./sync-adapter.js','./cloud-config.js','./manifest.webmanifest','./icons/quizlab-sgiungla-192.png','./icons/quizlab-sgiungla-512.png'];
const CORE=new Set(['index.html','styles.css','app.js','db.js','sync-adapter.js','cloud-config.js','manifest.webmanifest']);

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

async function networkFirst(request,fallback){
  const cache=await caches.open(CACHE);
  try{
    const fresh=await fetch(request,{cache:'no-store'});
    if(fresh&&fresh.ok)await cache.put(request,fresh.clone());
    return fresh;
  }catch(err){
    return (await caches.match(request)) || (fallback?await caches.match(fallback):null) || Response.error();
  }
}

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  const sameOrigin=url.origin===self.location.origin;
  const file=url.pathname.split('/').pop()||'';

  if(e.request.mode==='navigate'){
    e.respondWith(networkFirst(e.request,'./index.html'));
    return;
  }

  if(sameOrigin&&CORE.has(file)){
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{
      const copy=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copy));
      return r;
    }).catch(()=>caches.match('./index.html')))
  );
});
