/* Bounded, aggregate-only observations. Never collect names, answers or URLs. */
((root)=>{
 'use strict';
 if(root.QuizLabPerformance)return;
 const OPERATIONS=Object.freeze({startup:{label:'Avvio app',slow:3000},course_open:{label:'Apertura materia',slow:1000},answer:{label:'Conferma risposta',slow:700},local_save:{label:'Salvataggio sul dispositivo',slow:500},cloud_sync:{label:'Sincronizzazione cloud',slow:5000},gradebook_save:{label:'Salvataggio libretto',slow:700}});
 const KINDS=['pwa_desktop','pwa_mobile','extension_desktop'],MAX_PER_ROW=1000,MAX_BATCHES=4;
 let cfg=null,state=null,generation=0,persistTimer=null,flushTimer=null,pendingFlush=null;
 const clone=v=>JSON.parse(JSON.stringify(v)),utc=()=>new Date().toISOString().slice(0,10),clock=()=>{try{return root.performance?.now?.()??Date.now();}catch{return Date.now();}};
 const storageDefault={get:async key=>{try{return root.localStorage?.getItem(key);}catch{return null;}},set:async(key,value)=>root.localStorage?.setItem(key,value),remove:async key=>root.localStorage?.removeItem(key)};
 const key=()=>cfg?'unisgiunglalab.performance.v1.'+cfg.accountId+'.'+cfg.kind:null;
 const current=()=>{try{return !!cfg&&cfg.currentAccount?.()===cfg.accountId;}catch{return false;}};
 const mayUpload=()=>{try{return cfg?.canUpload?.()===true;}catch{return false;}};
 function empty(){return {version:1,totals:{},active:{},batches:[],nextAt:0,lastUploadAt:null,failures:0};}
 function prune(value){const oldest=new Date(Date.now()-6*86400000).toISOString().slice(0,10),today=utc();for(const field of ['totals','active'])for(const [k,row]of Object.entries(value[field]||{}))if(!row||row.day<oldest||row.day>today||!Object.hasOwn(OPERATIONS,row.operation))delete value[field][k];value.batches=(value.batches||[]).filter(b=>Array.isArray(b.rows)&&b.rows.length&&b.rows.every(r=>r.day>=oldest&&r.day<=today)).slice(0,MAX_BATCHES);return value;}
 function validRow(row){return row&&/^\d{4}-\d{2}-\d{2}$/.test(row.day)&&Object.hasOwn(OPERATIONS,row.operation)&&Number.isInteger(row.count)&&row.count>0&&row.count<=MAX_PER_ROW&&Number.isFinite(row.totalMs)&&row.totalMs>=0&&Number.isFinite(row.maxMs)&&row.maxMs>=0&&row.maxMs<=120000&&Number.isInteger(row.errors)&&row.errors>=0&&row.errors<=row.count&&Number.isInteger(row.slow)&&row.slow>=0&&row.slow<=row.count;}
 function decode(raw){try{const v=typeof raw==='string'?JSON.parse(raw):raw;if(v?.version!==1||!v.totals||!v.active||!Array.isArray(v.batches))return empty();for(const field of ['totals','active'])for(const [k,row]of Object.entries(v[field]))if(!validRow(row)||k!==row.day+':'+row.operation)delete v[field][k];v.batches=v.batches.filter(b=>/^[0-9a-f-]{36}$/i.test(b.id)&&b.rows.length<=42&&b.rows.every(validRow));v.nextAt=Number.isFinite(v.nextAt)&&v.nextAt<Date.now()+1800000?v.nextAt:0;return prune(v);}catch{return empty();}}
 async function persist(){if(!current()||!state)return false;const stamp=generation,id=key(),value=JSON.stringify(prune(state)),storage=cfg.storage||storageDefault;try{if(stamp!==generation)return false;await storage.set(id,value);return true;}catch{return false;/* Performance observations never block study. */}}
 function soon(){clearTimeout(persistTimer);persistTimer=setTimeout(()=>{persist().catch(()=>{});},500);}
 function schedule(delay=120000){clearTimeout(flushTimer);if(!cfg||typeof cfg.request!=='function')return;flushTimer=setTimeout(()=>{flush().catch(()=>{});},Math.max(1000,delay));}
 async function configure(options){
  const stamp=++generation;clearTimeout(persistTimer);clearTimeout(flushTimer);cfg=null;state=null;pendingFlush=null;
  if(!options?.accountId||typeof options.accountId!=='string'||!KINDS.includes(options.kind)||typeof options.currentAccount!=='function')return;
  cfg={...options};const own=cfg,storage=cfg.storage||storageDefault;let raw;try{raw=await storage.get(key());}catch{}
  if(stamp!==generation||cfg!==own||!current())return;
  state=decode(raw);schedule();return snapshot();
 }
 function observe(operation,duration,{ok=true}={}){
  if(!current()||!state||!Object.hasOwn(OPERATIONS,operation)||!Number.isFinite(duration)||duration<0||duration>120000)return false;
  const day=utc(),rowKey=day+':'+operation;
  if((state.totals[rowKey]?.count||0)>=MAX_PER_ROW)return false;
  const ms=Math.round(duration*10)/10;
  for(const field of ['totals','active']){const r=state[field][rowKey]||(state[field][rowKey]={day,operation,count:0,totalMs:0,maxMs:0,errors:0,slow:0});r.count++;r.totalMs=Math.round((r.totalMs+ms)*10)/10;r.maxMs=Math.max(r.maxMs,ms);r.errors+=ok===false?1:0;r.slow+=ms>OPERATIONS[operation].slow?1:0;}
  soon();return true;
 }
 function start(operation){const at=clock(),stamp=generation;let done=false;return options=>{if(done)return false;done=true;return stamp===generation?observe(operation,clock()-at,options):false;};}
 async function measure(operation,fn){const end=start(operation);try{const value=await fn();end({ok:true});return value;}catch(e){end({ok:false});throw e;}}
 function snapshot(){if(!current()||!state)return {available:false,rows:[],source:'device-observed',sampleCap:MAX_PER_ROW};return {available:true,kind:cfg.kind,rows:Object.values(state.totals).map(r=>({...clone(r),averageMs:r.totalMs/r.count,slowThresholdMs:OPERATIONS[r.operation].slow})),pendingBatches:state.batches.length,pendingSamples:Object.values(state.active).reduce((n,r)=>n+r.count,0),lastUploadAt:state.lastUploadAt,nextRetryAt:state.nextAt?new Date(state.nextAt).toISOString():null,source:'device-observed',sampleCap:MAX_PER_ROW};}
 async function flush(){
  if(pendingFlush)return pendingFlush;
  if(!current()||!state||typeof cfg.request!=='function')return {sent:false,reason:'unconfigured'};
  if(!mayUpload()||root.navigator?.onLine===false){schedule(300000);return {sent:false,reason:'access-or-offline'};}
  if(Date.now()<state.nextAt){schedule(state.nextAt-Date.now());return {sent:false,reason:'backoff'};}
  const stamp=generation,own=cfg,local=state;
  pendingFlush=(async()=>{
   prune(local);
   if(!local.batches.length&&Object.keys(local.active).length){local.batches.push({id:root.crypto?.randomUUID?.()||'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);}),rows:Object.values(local.active)});local.active={};}
   const batch=local.batches[0];if(!batch){schedule(300000);return {sent:false,reason:'empty'};}
   // Keep the retry ID durable before an upload; storage failure only skips
   // telemetry, never the study activity whose duration has been observed.
   if(!await persist()){schedule(300000);return {sent:false,reason:'storage-unavailable'};}
   if(stamp!==generation||!current())return {sent:false,reason:'account-changed'};
   let timeout;
   try{
    const result=await Promise.race([own.request('performance/collect',{batch_id:batch.id,kind:own.kind,rows:clone(batch.rows)}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Object.assign(Error('Performance upload timeout'),{status:408})),10000);})]);
    if(stamp!==generation||!current())return {sent:false,reason:'account-changed'};
    if(result?.accepted!==true)throw Object.assign(Error('Performance receipt not confirmed'),{status:503});
    if(local.batches[0]?.id===batch.id)local.batches.shift();local.lastUploadAt=new Date().toISOString();local.failures=0;local.nextAt=Date.now()+300000;await persist();schedule(300000);return {sent:true};
   }catch(error){
    if(stamp===generation&&current()){local.failures=Math.min(6,(local.failures||0)+1);const status=Number(error?.status)||0;local.nextAt=Date.now()+(status===402?900000:status===429?300000:Math.min(900000,60000*2**(local.failures-1)));await persist();schedule(local.nextAt-Date.now());}
    return {sent:false,reason:'retry'};
   }finally{clearTimeout(timeout);}
  })();
  const p=pendingFlush;try{return await p;}finally{if(pendingFlush===p)pendingFlush=null;}
 }
 root.addEventListener?.('pagehide',()=>{clearTimeout(persistTimer);persist().catch(()=>{});});
 root.QuizLabPerformance=Object.freeze({configure,observe,start,measure,snapshot,flush,persist,operations:OPERATIONS,kinds:KINDS});
})(globalThis);
