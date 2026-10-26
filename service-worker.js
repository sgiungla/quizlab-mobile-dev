const CACHE='quizlab-v0.11.27';
const ROOT=new URL('./',self.location.href);
const INDEX=new URL('./index.html',ROOT).href;
const MANIFEST=new URL('./asset-manifest.json',ROOT).href;
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
let assets=null;
const assetUrls=async()=>{
 if(assets)return assets;
 const cache=await caches.open(CACHE),manifest=await cache.match(MANIFEST);
 if(!manifest)return new Set();
 const data=await manifest.json();assets=new Set(data.assets.map(x=>new URL(x,ROOT).href));assets.add(MANIFEST);return assets;
};
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const response=await fetch(MANIFEST,{cache:'no-store'});if(!response.ok)throw Error('Release manifest unavailable');
 const data=await response.clone().json();if(data.version!=='0.11.27'||!Array.isArray(data.assets)||!data.sha256)throw Error('Incoherent release');
 const urls=data.assets.map(x=>new URL(x,ROOT));if(urls.some(u=>u.origin!==ROOT.origin||!u.href.startsWith(ROOT.href)))throw Error('Invalid asset path');
 const validated=[];
 // Validate every byte before exposing this release. A cached CDN response from
 // the previous deployment must not produce a mixed page/module installation.
 for(let offset=0;offset<urls.length;offset+=6){
  const batch=await Promise.all(urls.slice(offset,offset+6).map(async u=>{
   const relative='./'+u.pathname.slice(ROOT.pathname.length),key=relative==='./'?'./index.html':relative;
   const expected=data.sha256[key];if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('Missing asset digest');
   const asset=await fetch(new Request(u.href,{cache:'reload'}));if(!asset.ok||asset.type==='opaque')throw Error('Asset unavailable');
   const body=await asset.clone().arrayBuffer(),actual=hex(await crypto.subtle.digest('SHA-256',body));
   if(actual!==expected)throw Error('Asset digest mismatch');
   return [u.href,asset];
  }));validated.push(...batch);
 }
 const cache=await caches.open(CACHE);for(const [url,asset] of validated)await cache.put(url,asset);await cache.put(MANIFEST,response);
 // An existing page stays on its coherent cached release until its update manager has saved it.
})().catch(async error=>{
 const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
 for(const client of clients)if(client.url.startsWith(ROOT.href))client.postMessage({type:'QUIZLAB_UPDATE_FAILED',code:String(error?.message||'Installazione non riuscita').slice(0,120)});
 throw error;
})));
self.addEventListener('message',event=>{if(event.data?.type==='QUIZLAB_ACTIVATE_UPDATE'&&event.source?.url?.startsWith(ROOT.href))event.waitUntil(self.skipWaiting());});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 await self.clients.claim();
 const keys=await caches.keys();await Promise.all(keys.filter(k=>k!==CACHE&&(k.startsWith('quizlab-v')||k.startsWith('quizlab-static-')||k.startsWith('quizlab-mobile-dev-v'))).map(k=>caches.delete(k)));
})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==ROOT.origin||!url.href.startsWith(ROOT.href))return;
 if(url.pathname.endsWith('/service-worker.js')||url.pathname.endsWith('/release.json'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE),urls=await assetUrls();
  const key=request.mode==='navigate'?(url.pathname.endsWith('/admin.html')?new URL('./admin.html',ROOT).href:INDEX):url.origin+url.pathname;
  if(!urls.has(key))return fetch(request);
  // Static files belonging to an activated release are served only from its
  // verified cache. Missing files must not fall through to another deployment.
  return await cache.match(key)||new Response('Aggiornamento incompleto. Riapri QuizLab quando la rete è disponibile.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
 })());
});
