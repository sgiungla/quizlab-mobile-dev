// Bank revisions protect the whole document; per-question tombstones preserve
// concurrent additions without bringing explicit removals back.
function qlBankTime(bank={}) { return bank.updatedAt || bank.createdAt || '1970-01-01T00:00:00.000Z'; }
function qlMaxTime(a,b) { return String(a||'') >= String(b||'') ? (a||null) : (b||null); }
function qlTimeMap(a={},b={}) {
  const out={...a};
  for(const [key,value] of Object.entries(b||{})) out[key]=qlMaxTime(out[key],value);
  return out;
}
function qlShapeBank(bank={}) {
  const raw=bank.bankMeta||{};
  const times={...(raw.questionUpdatedAt||{})};
  for(const question of [...(bank.officialBank||[]),...(bank.aiBank||[])]) if(question?.id&&!times[question.id])times[question.id]=bank.createdAt||qlBankTime(bank);
  return {...bank,officialBank:Array.isArray(bank.officialBank)?bank.officialBank:[],aiBank:Array.isArray(bank.aiBank)?bank.aiBank:[],
    topicMap:Object.prototype.hasOwnProperty.call(bank,'topicMap')?bank.topicMap:null,aiWorkflow:bank.aiWorkflow||{},
    bankMeta:{version:1,resetAt:raw.resetAt||null,removedQuestionAt:{...(raw.removedQuestionAt||{})},questionUpdatedAt:times,
      topicMapUpdatedAt:raw.topicMapUpdatedAt||qlBankTime(bank)}};
}
function qlPrepareBank(course={}) {
  const bank=qlShapeBank({officialBank:course.officialBank,aiBank:course.aiBank,topicMap:course.topicMap??null,
    aiWorkflow:course.aiWorkflow||{},bankMeta:course.bankMeta||{},createdAt:course.createdAt||null,
    updatedAt:course.bankUpdatedAt||course.updatedAt||null});
  const base=course.cloudBankBase ? qlShapeBank(course.cloudBankBase) : null;
  if(base){
    const at=qlBankTime(bank), current=new Map([...bank.officialBank,...bank.aiBank].map(q=>[q.id,q]));
    const before=new Map([...base.officialBank,...base.aiBank].map(q=>[q.id,q]));
    for(const [id,old] of before) {
      if(!current.has(id))bank.bankMeta.removedQuestionAt[id]=qlMaxTime(bank.bankMeta.removedQuestionAt[id],at);
      else if(JSON.stringify(old)!==JSON.stringify(current.get(id)))bank.bankMeta.questionUpdatedAt[id]=at;
    }
    for(const id of current.keys())if(!before.has(id))bank.bankMeta.questionUpdatedAt[id]=at;
    if(JSON.stringify(bank.topicMap)!==JSON.stringify(base.topicMap))bank.bankMeta.topicMapUpdatedAt=at;
  }
  return bank;
}
function qlMergeBanks(left={},right={}) {
  const a=qlShapeBank(left),b=qlShapeBank(right);
  const resetAt=qlMaxTime(a.bankMeta.resetAt,b.bankMeta.resetAt);
  const removedQuestionAt=qlTimeMap(a.bankMeta.removedQuestionAt,b.bankMeta.removedQuestionAt);
  const questionUpdatedAt=qlTimeMap(a.bankMeta.questionUpdatedAt,b.bankMeta.questionUpdatedAt);
  const rows=new Map();
  const take=(bank,kind)=>{
    for(const q of bank[kind]){
      if(!q?.id)continue;
      const at=bank.bankMeta.questionUpdatedAt[q.id]||qlBankTime(bank);
      if(resetAt&&String(at)<String(resetAt))continue;
      if(removedQuestionAt[q.id]&&String(at)<=String(removedQuestionAt[q.id]))continue;
      const prior=rows.get(q.id);
      // Stable tie-break avoids direction-dependent conflict results.
      const signature=JSON.stringify(q);
      if(!prior||String(at)>String(prior.at)||(at===prior.at&&signature>prior.signature))rows.set(q.id,{q,kind,at,signature});
    }
  };
  take(a,'officialBank');take(a,'aiBank');take(b,'officialBank');take(b,'aiBank');
  const newer=String(qlBankTime(a))>String(qlBankTime(b))?a:b;
  const topicSource=String(a.bankMeta.topicMapUpdatedAt)>String(b.bankMeta.topicMapUpdatedAt)?a:b;
  const topicAt=qlMaxTime(a.bankMeta.topicMapUpdatedAt,b.bankMeta.topicMapUpdatedAt);
  const ordered=[...rows.values()].sort((x,y)=>String(x.q.id).localeCompare(String(y.q.id)));
  return {...newer,officialBank:ordered.filter(x=>x.kind==='officialBank').map(x=>x.q),
    aiBank:ordered.filter(x=>x.kind==='aiBank').map(x=>x.q),
    topicMap:resetAt&&String(topicAt)<String(resetAt)?null:topicSource.topicMap,
    bankMeta:{version:1,resetAt,removedQuestionAt,questionUpdatedAt,topicMapUpdatedAt:topicAt},
    createdAt:a.createdAt&&b.createdAt?(String(a.createdAt)<String(b.createdAt)?a.createdAt:b.createdAt):(a.createdAt||b.createdAt||null),
    updatedAt:qlMaxTime(qlBankTime(a),qlBankTime(b))};
}
function qlBankHash(bank={}) {
  const stable=value=>{
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
    return value;
  };
  const raw=JSON.stringify(stable({officialBank:bank.officialBank||[],aiBank:bank.aiBank||[],topicMap:bank.topicMap??null,aiWorkflow:bank.aiWorkflow||{},bankMeta:bank.bankMeta||{}}));
  let h1=2166136261,h2=2246822519;
  for(let i=0;i<raw.length;i++){h1=Math.imul(h1^raw.charCodeAt(i),16777619);h2=Math.imul(h2^raw.charCodeAt(i),3266489917);}
  return 'b_'+(h1>>>0).toString(36)+(h2>>>0).toString(36);
}
export class QuizLabSyncAdapter {
  constructor(){
    this.status='local-only';
    this.provider='supabase';
    this.client=null;
    this.session=null;
    this.authSubscription=null;
    this.generation=0;
    this.startGeneration=0;
    this.offlineIdentityGeneration=null;
    this.identityKey='quizlab.auth.identity.v1';
    this.authStorageKeys=new Set();
    this.signedOutLocally=false;
    this.recovery=null;
    this.remoteSnapshotCache=null;
    this.lastAuthHttpStatus=0;
    this.transportRetryKey='quizlab.transport-retry.v1';
    this.offlineAutoRefreshDisabled=false;
  }

  invalidateRemoteCache(courseId=null){
    const cache=this.remoteSnapshotCache;
    if(!courseId||!cache){this.remoteSnapshotCache=null;return;}
    for(const [id,row] of cache.banks)if(row.course_id===courseId){cache.banks.delete(id);cache.progress.delete(id);}
  }

  snapshotCache(token=this.operationToken()){
    this.assertOperation(token);
    const cache=this.remoteSnapshotCache;
    if(!cache||cache.userId!==token.userId||cache.generation!==token.generation||cache.client!==this.client){
      this.remoteSnapshotCache={userId:token.userId,generation:token.generation,client:this.client,banks:new Map(),progress:new Map()};
    }
    return this.remoteSnapshotCache;
  }

  snapshotSignature(row,kind){
    // Metadata is read on every pass. An old body is reused only while ALL
    // revision/identity fields match the fresh authoritative server snapshot.
    return kind==='bank'?JSON.stringify([row.id,row.course_id,row.bank_revision??0,row.bank_hash||'',row.updated_at||'',!!row.managed_by_admin,row.subject||'']):
      JSON.stringify([row.bank_id,row.revision??0,row.updated_at||'']);
  }

  async hydrateSnapshotRows(rows,kind,token,{prune=false,courses=null}={}){
    const cache=this.snapshotCache(token),store=kind==='bank'?cache.banks:cache.progress;
    const key=kind==='bank'?'id':'bank_id',body=kind==='bank'?'bank_json':'progress_json';
    const table=kind==='bank'?'quizlab_banks':'quizlab_user_courses';
    const owner=kind==='bank'?'owner_id':'user_id';
    const fields=kind==='bank'?'id,course_id,subject,bank_json,bank_revision,bank_hash,updated_at,managed_by_admin':'bank_id,progress_json,revision,updated_at';
    const clone=value=>JSON.parse(JSON.stringify(value));
    if(prune){const present=new Set(rows.map(row=>row[key]));for(const id of store.keys())if(!present.has(id))store.delete(id);}
    const changed=[];
    for(const row of rows){
      const local=kind==='bank'?courses?.[row.course_id]:null;
      // A previously confirmed cloud base may survive a page restart. Never
      // substitute the editable local bank: require its confirmed revision and
      // a fresh server hash matching the exact saved remote base.
      if(!store.has(row[key])&&local?.cloudBankBase&&row.bank_hash&&
          Number(local.cloudBankRevision)===Number(row.bank_revision)&&this.bankHash(local.cloudBankBase)===row.bank_hash){
        store.set(row[key],clone({...row,bank_json:local.cloudBankBase}));
      }
      // Accept a complete authoritative row if a compatible transport supplies
      // it; normal PostgREST metadata queries deliberately exclude the body.
      if(Object.prototype.hasOwnProperty.call(row,body))store.set(row[key],clone(row));
      else if(!store.has(row[key])||this.snapshotSignature(store.get(row[key]),kind)!==this.snapshotSignature(row,kind))changed.push(row[key]);
    }
    for(let offset=0;offset<changed.length;offset+=100){
      const ids=changed.slice(offset,offset+100);
      const {data,error,status:httpStatus}=await this.client.from(table).select(fields).eq(owner,token.userId).in(key,ids);
      this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);
      const found=new Set();
      for(const row of data||[]){if(!ids.includes(row[key]))continue;found.add(row[key]);store.set(row[key],clone(row));}
      // A deletion/revocation between metadata and body reads must not reuse a
      // stale cached body. The next poll also sees the new tombstone/absence.
      for(const id of ids)if(!found.has(id))store.delete(id);
    }
    this.assertOperation(token);
    return rows.flatMap(row=>{const full=store.get(row[key]);return full?[clone({...row,...full})]:[];});
  }

  async readSnapshotMetadata(table,fields,owner,token){
    const key=table==='quizlab_banks'?'id':'bank_id',rows=new Map();
    for(let offset=0;;offset+=500){
      let query=this.client.from(table).select(fields).eq(owner,token.userId);
      const paged=typeof query.range==='function'&&typeof query.order==='function';
      if(paged)query=query.order(key,{ascending:true}).range(offset,offset+499);
      const {data,error,status:httpStatus}=await query;
      this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);
      let added=0;for(const row of data||[]){if(!rows.has(row[key]))added++;rows.set(row[key],row);}
      if(!paged||(data||[]).length<500)break;
      if(!added)throw new Error('Paginazione cloud non valida: nessuna materia è stata modificata');
    }
    return [...rows.values()];
  }

  retryableAuthError(error){
    if(!error || [400,401,403].includes(Number(error.status)))return false;
    if([402,408,425,429].includes(Number(error.status))||Number(error.status)>=500)return true;
    return ['AuthRetryableFetchError','TimeoutError','AbortError'].includes(error.name) || (error.name==='TypeError' && /fetch|network|load failed/i.test(error.message||''));
  }

  transportBlock(){
    try{const r=JSON.parse(globalThis.localStorage?.getItem(this.transportRetryKey)||'null'),origin=new URL(this.authContext?.settings?.supabaseUrl||globalThis.QUIZLAB_LAB_CONFIG?.supabaseUrl).origin;return r?.endpoint===origin&&Number.isFinite(r.until)&&r.until>Date.now()&&[0,402,408,425,429,500,502,503,504].includes(r.status)?r:null;}catch{return null;}
  }

  httpError(error,status){
    // PostgREST exposes HTTP status beside error, not necessarily inside it.
    // Keep quota outages distinct from an explicit authentication denial.
    if(error&&!Number(error.status)&&Number(status||error.statusCode))error.status=Number(status||error.statusCode);
    return error;
  }

  cachedIdentity(){
    try{
      const value=JSON.parse(globalThis.localStorage?.getItem(this.identityKey)||'null');
      if(value?.version!==1 || typeof value.id!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id))return null;
      return {id:value.id,email:typeof value.email==='string'?value.email.slice(0,320):''};
    }catch{return null;}
  }

  rememberIdentity(user){
    // This cache only selects the local workspace. It never authorizes study or cloud writes.
    try{globalThis.localStorage?.setItem(this.identityKey,JSON.stringify({version:1,id:user.id,email:user.email||''}));}catch{}
  }

  forgetIdentity(){
    this.offlineIdentityGeneration=null;
    try{globalThis.localStorage?.removeItem(this.identityKey);}catch{}
  }

  authStorage(){
    // Let the SDK choose its storage keys; track only the keys it actually uses.
    // This also makes device-local logout work when the SDK cannot refresh offline.
    return {
      getItem:key=>{this.authStorageKeys.add(key);return globalThis.localStorage?.getItem(key)??null;},
      setItem:(key,value)=>{this.authStorageKeys.add(key);if(!this.signedOutLocally)globalThis.localStorage?.setItem(key,value);},
      removeItem:key=>{this.authStorageKeys.add(key);globalThis.localStorage?.removeItem(key);}
    };
  }

  clearAuthStorage(){
    for(const key of this.authStorageKeys){try{globalThis.localStorage?.removeItem(key);}catch{}}
  }

  applyAuthSession(event,session,{preserveIdentity=false}={}){
    if(event==='INITIAL_SESSION' && !session && this.session?.offlineIdentity && this.offlineIdentityGeneration===this.generation)return;
    if(this.signedOutLocally && session)return;
    if(session&&this.offlineAutoRefreshDisabled){this.offlineAutoRefreshDisabled=false;this.client?.auth?.startAutoRefresh?.();}
    // Reconfirmation/refresh of the same owner is not an account boundary.
    // Explicit signIn/signUp/signOut invalidate operations in their own methods.
    if(this.user()?.id!==session?.user?.id || event==='SIGNED_OUT')this.generation++;
    const cached=!session&&!this.signedOutLocally?this.cachedIdentity():null;
    const localIdentity=cached?.id===this.user()?.id?cached:null;
    this.session=session||(localIdentity?{user:localIdentity,offlineIdentity:true}:null);
    this.offlineIdentityGeneration=null;
    this.status=this.session?.offlineIdentity?'cloud-offline':this.session?'cloud-online':'cloud-ready';
    if(this.session?.user&&!this.session.offlineIdentity)this.rememberIdentity(this.session.user);else if(!this.session&&!preserveIdentity)this.forgetIdentity();
    this.authContext?.onAuthChange?.({event,session:this.session,status:this.status});
  }

  async readAuthSession(){
    // The SDK can wait on its initialization/refresh lock beyond an individual
    // fetch timeout. Keep local startup bounded without fabricating a session
    // or deleting persisted credentials when that lock is slow.
    let timer;const token=this.operationToken(),client=this.client;
    try{
      return await Promise.race([client.auth.getSession(),new Promise(resolve=>{
        timer=setTimeout(()=>{
          if(client===this.client&&this.isOperationCurrent(token)&&!this.transportBlock()){
            try{globalThis.localStorage?.setItem(this.transportRetryKey,JSON.stringify({endpoint:'https://eqrcdvhhfrkpmnzqoerr.supabase.co',status:408,failures:1,until:Date.now()+60000}));}catch{}
          }
          resolve({error:Object.assign(new Error('Ripristino cloud temporaneamente in attesa'),{name:'TimeoutError',status:408})});
        },12000);
      })]);
    }finally{clearTimeout(timer);}
  }

  async recoverSession(){
    if(!this.client || !this.session?.offlineIdentity || this.signedOutLocally)return !this.session?.offlineIdentity;
    if(this.transportBlock())return false;
    if(this.recovery)return this.recovery;
    const client=this.client,run=this.startGeneration,token=this.operationToken();
    this.recovery=(async()=>{
      let result;
      try{result=await this.readAuthSession();}catch(error){result={error};}
      if(result.error&&!Number(result.error.status)&&this.lastAuthHttpStatus>=400)result.error.status=this.lastAuthHttpStatus;
      if(run!==this.startGeneration || !this.isOperationCurrent(token))return false;
      if(result.error){
        if(this.retryableAuthError(result.error))return false;
        this.clearAuthStorage();this.applyAuthSession('SIGNED_OUT',null,{preserveIdentity:true});return false;
      }
      const session=result.data?.session||null;
      if(!session)return false;
      if(session&&session.user?.id!==token.userId)return false;
      this.applyAuthSession(session?.user?.id===token.userId?'TOKEN_REFRESHED':'SIGNED_IN',session);
      return !!session;
    })();
    try{return await this.recovery;}finally{this.recovery=null;}
  }

  configured(settings={}){
    return Boolean(settings?.supabaseUrl && settings?.supabasePublishableKey);
  }

  async cloudFetch(input,init={}){
    let endpoint=new URL(typeof input==='string'?input:input.url);
    if(endpoint.pathname==='/rest/v1/rpc/quizlab_license'){endpoint=new URL('/functions/v1/quizlab-runtime/license?client_modules=2',endpoint);input=endpoint.href;}
    if(!["https://eqrcdvhhfrkpmnzqoerr.supabase.co"].includes(endpoint.origin)||endpoint.username||endpoint.password)throw new Error('Collegamento cloud non consentito');
    const authRequest=endpoint.pathname.startsWith('/auth/v1/');
    let backoff;try{backoff=JSON.parse(globalThis.localStorage?.getItem(this.transportRetryKey)||'null');}catch{}
    if(backoff?.endpoint===endpoint.origin&&Date.now()<backoff.until){
      if(authRequest)this.lastAuthHttpStatus=backoff.status;
      const error=new Error('Cloud temporaneamente indisponibile. Dati locali conservati.');error.status=backoff.status;error.code='CLOUD_BACKOFF';throw error;
    }
    if(authRequest)this.lastAuthHttpStatus=0;
    const controller=new AbortController(),external=init.signal||input?.signal;
    let timedOut=false;
    const abort=()=>controller.abort(external?.reason);
    if(external?.aborted)abort();else external?.addEventListener?.('abort',abort,{once:true});
    const cleanup=()=>{clearTimeout(timer);external?.removeEventListener?.('abort',abort);};
    const timer=setTimeout(()=>{timedOut=true;controller.abort();cleanup();},15000);
    try{
      const response=await globalThis.fetch(input,{...init,signal:controller.signal});
      if([402,429,500,502,503,504].includes(response.status)){
        const failures=Math.min(10,(backoff?.failures||0)+1),delay=response.status===402?900000:response.status===429?60000:Math.min(300000,15000*2**(failures-1));
        try{globalThis.localStorage?.setItem(this.transportRetryKey,JSON.stringify({endpoint:endpoint.origin,status:response.status,failures,until:Date.now()+delay}));}catch{}
      }
      if(authRequest){
        this.lastAuthHttpStatus=response.status;
        if([402,408,425,429].includes(response.status)||response.status>=500){
          // GoTrue treats a normal AuthApiError402 as a rejected refresh token
          // and may delete the SDK session. A transport outage instead becomes
          // its retryable fetch error; explicit400/401/403 are unchanged.
          response.body?.cancel?.().catch?.(()=>{});
          const error=new Error('Cloud temporaneamente non disponibile (HTTP '+response.status+')');
          error.status=response.status;throw error;
        }
      }
      // Keep the deadline until the body has been consumed as well: a server
      // that sends headers and then stalls must not pin the sync queue forever.
      return new Proxy(response,{get(target,key){
        const value=Reflect.get(target,key,target);
        if(['text','json','arrayBuffer','blob','formData'].includes(key))return async(...args)=>{
          try{return await value.apply(target,args);}finally{cleanup();}
        };
        return typeof value==='function'?value.bind(target):value;
      }});
    }catch(error){
      cleanup();
      if(timedOut){const timeout=new Error('Il cloud non risponde: riprova più tardi');timeout.name='TimeoutError';timeout.code='LAB_TIMEOUT';throw timeout;}
      throw error;
    }
  }

  async start(context={}){
    this.invalidateRemoteCache();
    const run=++this.startGeneration,token=this.operationToken();
    this.authSubscription?.unsubscribe?.();
    this.authContext=context;
    if(this.recoveryListener){globalThis.removeEventListener?.('online',this.recoveryListener);globalThis.removeEventListener?.('focus',this.recoveryListener);globalThis.removeEventListener?.('storage',this.identityListener);}
    const settings=context.settings||{};
    const endpoint=new URL(settings.supabaseUrl||globalThis.QUIZLAB_LAB_CONFIG?.supabaseUrl||'http://127.0.0.1:54321');
    if(!["https://eqrcdvhhfrkpmnzqoerr.supabase.co"].includes(endpoint.origin)||endpoint.username||endpoint.password)throw new Error('Collegamento cloud non consentito');
    if(!this.configured(settings) || !globalThis.supabase?.createClient){
      this.status='local-only';
      return {status:this.status,provider:this.provider,online:navigator.onLine,user:null};
    }
    const block=this.transportBlock(),offlineBoot=!!block&&!!this.cachedIdentity()&&!this.signedOutLocally;
    this.offlineAutoRefreshDisabled=offlineBoot;
    this.client=globalThis.supabase.createClient(
      settings.supabaseUrl,
      settings.supabasePublishableKey,
      {auth:{persistSession:true,autoRefreshToken:!offlineBoot,detectSessionInUrl:true,storage:this.authStorage()},
        global:{fetch:(input,init)=>this.cloudFetch(input,init)}}
    );
    const client=this.client;
    let result;
    try{result=offlineBoot?{error:Object.assign(new Error('Cloud temporaneamente indisponibile; identità locale conservata'),{status:block.status})}:await this.readAuthSession();}catch(error){result={error};}
    if(result.error&&!Number(result.error.status)&&this.lastAuthHttpStatus>=400)result.error.status=this.lastAuthHttpStatus;
    if(run!==this.startGeneration || !this.isOperationCurrent(token))throw new Error('Operazione annullata: account cambiato');
    if(result.error){
      if(!this.retryableAuthError(result.error))this.clearAuthStorage();
      const user=this.cachedIdentity();
      if(user && !this.signedOutLocally){
        if(this.user()?.id!==user.id)this.generation++;
        this.session={user,offlineIdentity:true};this.offlineIdentityGeneration=this.generation;
      }else this.session=null;
    }else{
      this.session=result.data?.session||null;
      this.offlineIdentityGeneration=null;
      if(this.session?.user)this.rememberIdentity(this.session.user);
      else if(this.cachedIdentity()&&!this.signedOutLocally){this.session={user:this.cachedIdentity(),offlineIdentity:true};this.offlineIdentityGeneration=this.generation;}
    }
    this.status=this.session?.offlineIdentity?'cloud-offline':this.session?'cloud-online':'cloud-ready';
    const {data:listener}=this.client.auth.onAuthStateChange((event,session)=>{
      if(run!==this.startGeneration || client!==this.client)return;
      this.applyAuthSession(event,session);
    });
    this.authSubscription=listener?.subscription||null;
    this.recoveryListener=()=>{this.recoverSession().catch(()=>{});};
    this.identityListener=event=>{
      if(event.key!==this.identityKey || !this.session?.offlineIdentity)return;
      // A logout/account switch in another tab invalidates an offline workspace.
      const cached=this.cachedIdentity();
      if(cached?.id!==this.user()?.id){this.signedOutLocally=!cached;this.applyAuthSession('SIGNED_OUT',null,{preserveIdentity:true});}
    };
    globalThis.addEventListener?.('online',this.recoveryListener);
    globalThis.addEventListener?.('focus',this.recoveryListener);
    globalThis.addEventListener?.('storage',this.identityListener);
    return {status:this.status,provider:this.provider,online:navigator.onLine,user:this.session?.user||null};
  }

  user(){ return this.session?.user||null; }

  operationToken(){return {generation:this.generation,startGeneration:this.startGeneration,userId:this.user()?.id||null};}
  isOperationCurrent(token){return !!token&&token.generation===this.generation&&token.startGeneration===this.startGeneration&&token.userId===(this.user()?.id||null);}
  assertOperation(token){if(!this.isOperationCurrent(token))throw new Error('Operazione annullata: account cambiato');}

  requireUser(){
    const user=this.user();
    if(!this.client||!user) throw new Error('Accesso cloud richiesto');
    if(this.session?.offlineIdentity)throw new Error('Sessione cloud da ripristinare: identità locale disponibile solo per la licenza offline');
    return user;
  }

  async signUp(email,password,redirectTo){
    globalThis.localStorage?.removeItem(this.transportRetryKey);
    this.generation++;
    this.forgetIdentity();this.clearAuthStorage();this.session=null;this.signedOutLocally=false;
    if(!this.client) throw new Error('Cloud non configurato');
    return this.client.auth.signUp({email,password,options:{emailRedirectTo:redirectTo}});
  }

  async signIn(email,password){
    globalThis.localStorage?.removeItem(this.transportRetryKey);
    this.generation++;
    this.forgetIdentity();this.clearAuthStorage();this.session=null;this.signedOutLocally=false;
    if(!this.client) throw new Error('Cloud non configurato');
    return this.client.auth.signInWithPassword({email,password});
  }

  async signOut(){
    this.generation++;
    this.signedOutLocally=true;
    this.forgetIdentity();
    this.applyAuthSession('SIGNED_OUT',null);
    if(!this.client){this.clearAuthStorage();return;}
    // Device-local logout: remove only this browser/PWA session.
    // Other devices using the same QuizLab account remain signed in.
    try{
      const {error,status:httpStatus}=await this.client.auth.signOut({scope:'local'});
      if(error && !this.retryableAuthError(error))throw error;
    }finally{
      // A newer explicit login owns the storage from that point onward.
      if(this.signedOutLocally)this.clearAuthStorage();
    }
  }

  async upsertProfile(profile={}){
    const user=this.requireUser();
    const token=this.operationToken();
    const row={
      user_id:user.id,
      display_name:profile.displayName||'',
      avatar_url:profile.avatarPath||null,
      motto:profile.motto||'La giungla universitaria è sotto controllo.',
      updated_at:new Date().toISOString()
    };
    const {error,status:httpStatus}=await this.client.from('quizlab_profiles').upsert(row,{onConflict:'user_id'});
    this.assertOperation(token);
    if(error) throw this.httpError(error,httpStatus);
  }

  async uploadAvatar(file){
    const user=this.requireUser();
    const token=this.operationToken();
    if(!file) throw new Error('Nessun file selezionato');
    const type=String(file.type||'').toLowerCase();
    if(!['image/jpeg','image/png','image/webp','image/gif'].includes(type)) throw new Error('Formato immagine non supportato');
    if(file.size>2.5*1024*1024) throw new Error('Foto troppo grande: massimo 2,5 MB');
    const ext=type==='image/png'?'png':type==='image/webp'?'webp':type==='image/gif'?'gif':'jpg';
    const path=user.id+'/avatar.'+ext;
    const {error,status:httpStatus}=await this.client.storage.from('quizlab-avatars').upload(path,file,{
      cacheControl:'3600',
      upsert:true,
      contentType:type
    });
    this.assertOperation(token);
    if(error) throw this.httpError(error,httpStatus);
    return path;
  }

  async signedAvatarUrl(path){
    const token=this.operationToken();
    if(!path)return '';
    const {data,error,status:httpStatus}=await this.client.storage.from('quizlab-avatars').createSignedUrl(path,60*60*24*7);
    if(error) throw this.httpError(error,httpStatus);
    this.assertOperation(token);
    const base=this.authContext?.settings?.supabaseUrl||this.client?.supabaseUrl||globalThis.QUIZLAB_LAB_CONFIG?.supabaseUrl||'http://127.0.0.1:54321';
    if(data?.signedUrl&&(new URL(data.signedUrl).origin!==new URL(base).origin||new URL(data.signedUrl).username||new URL(data.signedUrl).password))throw new Error('Collegamento avatar non consentito');
    return data?.signedUrl||'';
  }

  async pullProfile(){
    const user=this.requireUser();
    const token=this.operationToken();
    const {data,error,status:httpStatus}=await this.client
      .from('quizlab_profiles')
      .select('display_name,avatar_url,motto,updated_at')
      .eq('user_id',user.id)
      .maybeSingle();
    this.assertOperation(token);
    if(error) throw this.httpError(error,httpStatus);
    if(!data)return null;
    let avatar_signed_url='';
    if(data.avatar_url){
      try{avatar_signed_url=await this.signedAvatarUrl(data.avatar_url);}catch(e){console.warn('Avatar signed URL',e);}
    }
    this.assertOperation(token);
    return {...data,avatar_signed_url};
  }

  async accessState(){
    this.requireUser();
    const token=this.operationToken();
    const {data:status,error:statusError,status:httpStatus}=await this.client.rpc('quizlab_account_status');
    this.assertOperation(token);
    if(statusError){
      throw this.httpError(statusError,httpStatus);
    }
    const {data:isAdmin,error:adminError,status:adminHttpStatus}=await this.client.rpc('quizlab_is_admin');
    this.assertOperation(token);
    if(adminError) throw this.httpError(adminError,adminHttpStatus);
    return {status:status||'pending',isAdmin:Boolean(isAdmin)};
  }

  async ensurePendingRegistration(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_register_pending_user');
    if(error){
      throw this.httpError(error,httpStatus);
    }
    return data||'pending';
  }

  async adminUserOverview(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_user_overview');
    if(error) throw this.httpError(error,httpStatus);
    return data||[];
  }

  async adminUsersPage(filters={}){
    this.requireUser();
    const token=this.operationToken();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_users_page',filters);
    this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);return data||{items:[],total:0,summary:{}};
  }
  async adminUserDetail(userId){
    this.requireUser();const token=this.operationToken();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_user_detail',{target_user_id:userId});
    this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);return data;
  }
  async adminCourseSummary(){
    this.requireUser();const token=this.operationToken();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_course_summary');
    this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);return data||[];
  }
  async adminListPlans(){
    this.requireUser();const token=this.operationToken();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_list_plans');
    this.assertOperation(token);if(error)throw this.httpError(error,httpStatus);return data||[];
  }

  async adminStorageOverview(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_storage_overview');
    if(error) throw this.httpError(error,httpStatus);
    return Array.isArray(data)?(data[0]||null):data;
  }

  async adminUserCourseStats(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_user_course_stats');
    if(error) throw this.httpError(error,httpStatus);
    return data||[];
  }

  async adminSetUserStatus(userId,status){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_set_user_status',{target_user:userId,new_status:status});
    if(error) throw this.httpError(error,httpStatus);
    return data;
  }

  async adminSetUserExpiry(userId,expiresAt){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_set_expiry',{target_user_id:userId,target_expires_at:expiresAt||null});
    if(error)throw this.httpError(error,httpStatus);return data;
  }
  async adminUserLicenses(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_user_licenses');
    if(error)throw this.httpError(error,httpStatus);return data||[];
  }
  async adminListAssignments(userId){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_list_assignments',{target_user_id:userId});
    if(error)throw this.httpError(error,httpStatus);return data||[];
  }
  async adminAssignBank(userId,courseId,bank,subject,expectedRevision=0){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_assign_course',{
      target_user_id:userId,target_course_id:courseId,target_subject:subject||courseId,
      incoming_bank:bank,expected_revision:Number(expectedRevision||0)
    });
    if(error)throw this.httpError(error,httpStatus);return data;
  }

  bankPayload(course={}){
    return qlPrepareBank(course);
  }

  mergeBanks(local={},remote={}){return qlMergeBanks(local,remote);}
  bankHash(bank={}){return qlBankHash(bank);}
  applyBankToCourse(course={},bank={},revision=null,updatedAt=null){
    const shaped=qlShapeBank(bank);
    return {...course,officialBank:shaped.officialBank,aiBank:shaped.aiBank,topicMap:shaped.topicMap,
      aiWorkflow:shaped.aiWorkflow,bankMeta:shaped.bankMeta,bankUpdatedAt:shaped.updatedAt||updatedAt||course.bankUpdatedAt,
      cloudBankRevision:revision??course.cloudBankRevision,cloudBankBase:shaped};
  }

  maxIso(a,b){
    if(!a)return b||null;
    if(!b)return a||null;
    return String(a)>=String(b)?a:b;
  }

  eventId(kind,event={}){
    if(event.eventId)return String(event.eventId);
    const raw=JSON.stringify([
      kind,event.at||'',event.questionId||'',event.mode||'',event.answer||'',
      event.correct??'',event.elapsedMs??'',event.grade??'',event.lode??'',
      Array.isArray(event.questionIds)?event.questionIds.join(','):'',
      Array.isArray(event.wrongIds)?event.wrongIds.join(','):''
    ]);
    let h1=2166136261,h2=2246822519;
    for(let i=0;i<raw.length;i++){
      const c=raw.charCodeAt(i);
      h1=Math.imul(h1^c,16777619);
      h2=Math.imul(h2^c,3266489917);
    }
    return 'legacy_'+kind+'_'+(h1>>>0).toString(36)+(h2>>>0).toString(36);
  }

  normalizeStateMap(raw={}){
    const out={};
    if(!raw||typeof raw!=='object')return out;
    for(const [id,state] of Object.entries(raw)){
      if(!id)continue;
      if(state&&typeof state==='object'){
        out[id]={value:Boolean(state.value),at:state.at||null};
      }
    }
    return out;
  }

  normalizeTimeMap(raw={}){
    const out={};
    if(!raw||typeof raw!=='object')return out;
    for(const [id,at] of Object.entries(raw))if(id&&at)out[id]=String(at);
    return out;
  }

  normalizeProgress(progress={}){
    const p=progress&&typeof progress==='object'?progress:{};
    const baseAt=p.updatedAt||p.createdAt||'1970-01-01T00:00:00.000Z';
    const rawMeta=p.syncMeta&&typeof p.syncMeta==='object'?p.syncMeta:{};
    const meta={
      version:3,
      performanceResetAt:rawMeta.performanceResetAt||null,
      examResetAt:rawMeta.examResetAt||null,
      reviewResetAt:rawMeta.reviewResetAt||null,
      removedQuestionAt:this.normalizeTimeMap(rawMeta.removedQuestionAt),
      markedState:this.normalizeStateMap(rawMeta.markedState),
      pendingState:this.normalizeStateMap(rawMeta.pendingState),
      historicalWrongAt:this.normalizeTimeMap(rawMeta.historicalWrongAt),
      fullSeenAt:this.normalizeTimeMap(rawMeta.fullSeenAt)
    };

    const marked=Array.isArray(p.marked)?[...new Set(p.marked.filter(Boolean))]:[];
    const pendingReview=Array.isArray(p.pendingReview)?[...new Set(p.pendingReview.filter(Boolean))]:[];
    const historicalWrong=Array.isArray(p.historicalWrong)?[...new Set(p.historicalWrong.filter(Boolean))]:[];
    const fullCampaign={
      signature:p.fullCampaign?.signature||'all',
      seenIds:Array.isArray(p.fullCampaign?.seenIds)?[...new Set(p.fullCampaign.seenIds.filter(Boolean))]:[],
      resetAt:p.fullCampaign?.resetAt||null
    };

    for(const id of marked)if(!meta.markedState[id])meta.markedState[id]={value:true,at:baseAt};
    for(const id of pendingReview)if(!meta.pendingState[id])meta.pendingState[id]={value:true,at:baseAt};
    for(const id of historicalWrong)if(!meta.historicalWrongAt[id])meta.historicalWrongAt[id]=baseAt;
    for(const id of fullCampaign.seenIds)if(!meta.fullSeenAt[id])meta.fullSeenAt[id]=baseAt;

    const attempts=(Array.isArray(p.attempts)?p.attempts:[]).map(e=>({...e,eventId:this.eventId('attempt',e)}));
    const exams=(Array.isArray(p.exams)?p.exams:[]).map(e=>({...e,eventId:this.eventId('exam',e)}));

    return {
      attempts,exams,marked,pendingReview,historicalWrong,fullCampaign,syncMeta:meta,
      createdAt:p.createdAt||null,updatedAt:p.updatedAt||null
    };
  }

  mergeStateMaps(a={},b={}){
    const out={};
    for(const [id,state] of [...Object.entries(a||{}),...Object.entries(b||{})]){
      if(!id||!state)continue;
      const prev=out[id];
      if(!prev||String(state.at||'')>=String(prev.at||''))out[id]={value:Boolean(state.value),at:state.at||null};
    }
    return out;
  }

  mergeTimeMaps(a={},b={}){
    const out={...(a||{})};
    for(const [id,at] of Object.entries(b||{})){
      if(!out[id]||String(at)>=String(out[id]))out[id]=at;
    }
    return out;
  }

  eventSurvives(e,resetAt=null,removedQuestionAt={}){
    if(resetAt&&(!e?.at||String(e.at)<String(resetAt)))return false;
    const removedAt=e?.questionId?removedQuestionAt?.[e.questionId]:null;
    if(removedAt&&(!e?.at||String(e.at)<String(removedAt)))return false;
    return true;
  }

  mergeEvents(a=[],b=[],kind,resetAt=null,removedQuestionAt={}){
    const map=new Map();
    for(const raw of [...a,...b]){
      const e={...raw,eventId:this.eventId(kind,raw)};
      const key=e.eventId;
      const prev=map.get(key);
      if(!prev||String(e.at||'')>=String(prev.at||''))map.set(key,e);
    }
    return [...map.values()]
      .filter(e=>this.eventSurvives(e,resetAt,removedQuestionAt))
      .sort((x,y)=>String(x.at||'').localeCompare(String(y.at||'')));
  }

  mergeProgress(localProgress={},remoteProgress={}){
    const a=this.normalizeProgress(localProgress);
    const b=this.normalizeProgress(remoteProgress);
    const performanceResetAt=this.maxIso(a.syncMeta.performanceResetAt,b.syncMeta.performanceResetAt);
    const examResetAt=this.maxIso(a.syncMeta.examResetAt,b.syncMeta.examResetAt);
    const reviewResetAt=this.maxIso(a.syncMeta.reviewResetAt,b.syncMeta.reviewResetAt);
    const removedQuestionAt=this.mergeTimeMaps(a.syncMeta.removedQuestionAt,b.syncMeta.removedQuestionAt);
    const attempts=this.mergeEvents(a.attempts,b.attempts,'attempt',performanceResetAt,removedQuestionAt);
    const exams=this.mergeEvents(a.exams,b.exams,'exam',this.maxIso(performanceResetAt,examResetAt));
    const markedState=this.mergeStateMaps(a.syncMeta.markedState,b.syncMeta.markedState);
    const pendingState=this.mergeStateMaps(a.syncMeta.pendingState,b.syncMeta.pendingState);
    const historicalWrongAt=this.mergeTimeMaps(a.syncMeta.historicalWrongAt,b.syncMeta.historicalWrongAt);
    const fullSeenAt=this.mergeTimeMaps(a.syncMeta.fullSeenAt,b.syncMeta.fullSeenAt);

    for(const e of attempts){
      if(!e.questionId||!e.at)continue;
      if(e.correct===false){
        const prev=pendingState[e.questionId];
        if(!prev||String(e.at)>=String(prev.at||''))pendingState[e.questionId]={value:true,at:e.at};
        if(!historicalWrongAt[e.questionId]||String(e.at)>=String(historicalWrongAt[e.questionId]))historicalWrongAt[e.questionId]=e.at;
      }
    }

    const stateSurvives=(id,at,resetAt)=>{
      if(resetAt&&(!at||String(at)<String(resetAt)))return false;
      const removedAt=removedQuestionAt[id];
      if(removedAt&&(!at||String(at)<String(removedAt)))return false;
      return true;
    };
    const marked=Object.entries(markedState)
      .filter(([id,v])=>v.value&&stateSurvives(id,v.at,reviewResetAt))
      .map(([id])=>id);
    const pendingReview=Object.entries(pendingState)
      .filter(([id,v])=>v.value&&stateSurvives(id,v.at,reviewResetAt))
      .map(([id])=>id);
    const historicalWrong=Object.entries(historicalWrongAt)
      .filter(([id,at])=>stateSurvives(id,at,reviewResetAt))
      .map(([id])=>id);

    const fullResetAt=this.maxIso(a.fullCampaign.resetAt,b.fullCampaign.resetAt);
    for(const e of attempts){
      if(e.mode==='full'&&e.questionId&&e.at&&(!fullResetAt||String(e.at)>=String(fullResetAt))){
        if(!fullSeenAt[e.questionId]||String(e.at)>=String(fullSeenAt[e.questionId]))fullSeenAt[e.questionId]=e.at;
      }
    }
    const seenIds=Object.entries(fullSeenAt)
      .filter(([id,at])=>stateSurvives(id,at,fullResetAt))
      .map(([id])=>id);

    return {
      attempts,exams,marked,pendingReview,historicalWrong,
      fullCampaign:{signature:'all',seenIds,resetAt:fullResetAt},
      syncMeta:{version:3,performanceResetAt,examResetAt,reviewResetAt,removedQuestionAt,markedState,pendingState,historicalWrongAt,fullSeenAt},
      createdAt:a.createdAt&&b.createdAt?(String(a.createdAt)<=String(b.createdAt)?a.createdAt:b.createdAt):(a.createdAt||b.createdAt||null),
      updatedAt:new Date().toISOString()
    };
  }

  progressPayload(course={}){
    return this.normalizeProgress({
      attempts:Array.isArray(course.attempts)?course.attempts:[],
      exams:Array.isArray(course.exams)?course.exams:[],
      marked:Array.isArray(course.marked)?course.marked:[],
      pendingReview:Array.isArray(course.pendingReview)?course.pendingReview:[],
      historicalWrong:Array.isArray(course.historicalWrong)?course.historicalWrong:[],
      fullCampaign:course.fullCampaign||{signature:'all',seenIds:[],resetAt:null},
      syncMeta:course.syncMeta||{},
      createdAt:course.createdAt||null,
      updatedAt:course.updatedAt||null
    });
  }

  async saveProgressAtomic(bankId,expectedRevision,progress){
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_save_progress_v2',{
      target_bank_id:bankId,
      expected_revision:Number(expectedRevision||0),
      incoming_progress:progress
    });
    if(error){
      throw this.httpError(error,httpStatus);
    }
    return data||{};
  }

  async pushCourse(courseId,course={},options={}){
    const user=this.requireUser();
    const token=this.operationToken();
    const now=new Date().toISOString();
    let bank=null;
    const {data:existingBank,error:bankError,status:httpStatus}=await this.client.from('quizlab_banks')
      .select('id,course_id,bank_hash,bank_revision,updated_at,subject,managed_by_admin')
      .eq('owner_id',user.id).eq('course_id',courseId).maybeSingle();
    this.assertOperation(token);
    if(bankError)throw this.httpError(bankError,httpStatus);
    bank=existingBank?(await this.hydrateSnapshotRows([existingBank],'bank',token,{courses:{[courseId]:course}}))[0]||null:null;
    if(options.bankDirty||!bank){
      let bankSaved=false;
      let expectedRevision=Number(bank?.bank_revision||0);
      let incoming=bank?this.mergeBanks(this.bankPayload(course),bank.bank_json||{}):this.bankPayload(course);
      for(let attempt=0;attempt<5;attempt++){
        this.assertOperation(token);
        const {data:out,error,status:httpStatus}=await this.client.rpc('quizlab_save_bank_v2',{
          target_course_id:courseId,expected_revision:expectedRevision,incoming_bank:incoming,
          target_subject:course.subject||courseId,incoming_hash:this.bankHash(incoming)
        });
        this.assertOperation(token);
        if(error)throw this.httpError(error,httpStatus);
        if(out?.ok){bank={id:out.bank_id,bank_json:out.bank_json||incoming,bank_revision:Number(out.revision),
          bank_hash:out.bank_hash,updated_at:out.updated_at,subject:out.subject,readonly:!!out.readonly,managed_by_admin:!!out.managed_by_admin};bankSaved=true;break;}
        if(out?.conflict){expectedRevision=Number(out.revision||0);incoming=this.mergeBanks(incoming,out.bank_json||{});continue;}
        throw new Error('Risposta banca cloud non valida');
      }
      if(!bankSaved||!bank?.id)throw new Error('Conflitto banca persistente: riprova');
      this.snapshotCache(token).banks.set(bank.id,JSON.parse(JSON.stringify({...bank,course_id:courseId})));
    }

    const {data:existing,error:revError,status:progressHttpStatus}=await this.client
      .from('quizlab_user_courses')
      .select('bank_id,revision,updated_at')
      .eq('user_id',user.id)
      .eq('bank_id',bank.id)
      .maybeSingle();
    this.assertOperation(token);
    if(revError) throw this.httpError(revError,progressHttpStatus);
    const freshProgress=existing?(await this.hydrateSnapshotRows([{...existing,bank_id:bank.id}],'progress',token))[0]||null:null;
    if(!freshProgress)this.snapshotCache(token).progress.delete(bank.id);

    // IMPORTANT: use the revision last seen by THIS device.
    // Reading the newest revision and then writing against it would let a stale
    // device overwrite changes made elsewhere without ever producing a conflict.
    const hasKnownRevision=course.cloudRevision!==undefined&&course.cloudRevision!==null;
    let expectedRevision=hasKnownRevision?Number(course.cloudRevision||0):Number(freshProgress?.revision||0);
    let progress=this.progressPayload(course);

    // Safety invariant: ALWAYS merge the fresh server snapshot before writing.
    // A stale client may still carry the latest revision number but a poorer
    // local payload; without this merge it could overwrite newer progress
    // without producing a revision conflict. Explicit newer resets still win.
    if(freshProgress?.progress_json){
      progress=this.mergeProgress(progress,freshProgress.progress_json);
    }

    for(let attempt=0;attempt<5;attempt++){
      this.assertOperation(token);
      const out=await this.saveProgressAtomic(bank.id,expectedRevision,progress);
      this.assertOperation(token);

      if(out.ok){
        this.snapshotCache(token).progress.set(bank.id,JSON.parse(JSON.stringify({bank_id:bank.id,
          revision:Number(out.revision||expectedRevision+1),progress_json:out.progress||progress,updated_at:out.updated_at||null})));
        return {
          courseId,
          subject:bank.subject||course.subject||courseId,
          bankId:bank.id,
          bank:bank.bank_json||{},bankRevision:Number(bank.bank_revision||0),bankUpdatedAt:bank.updated_at||null,
          readonly:!!bank.readonly,managedByAdmin:!!bank.managed_by_admin,
          revision:Number(out.revision||expectedRevision+1),
          progress:this.normalizeProgress(this.mergeProgress(progress,out.progress||{})),
          merged:attempt>0
        };
      }

      if(out.conflict){
        expectedRevision=Number(out.revision||0);
        progress=this.mergeProgress(progress,out.progress||{});
        continue;
      }

      throw new Error('Risposta cloud non valida durante la sincronizzazione');
    }

    throw new Error('Conflitto di sincronizzazione persistente: riprova');
  }

  async deleteCloudCourse(courseId){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_delete_my_course',{target_course_id:courseId});
    if(error) throw this.httpError(error,httpStatus);
    this.invalidateRemoteCache(courseId);
    return data||{course_id:courseId,deleted_banks:0};
  }

  async restoreMyCourse(courseId){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_restore_my_course',{target_course_id:courseId});
    if(error) throw this.httpError(error,httpStatus);
    this.invalidateRemoteCache(courseId);
    return Boolean(data);
  }

  async blockedCourseIds(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_blocked_course_ids');
    if(error){
      if(error.code==='42883') return [];
      throw this.httpError(error,httpStatus);
    }
    return (data||[]).map(x=>typeof x==='string'?x:x?.course_id).filter(Boolean);
  }

  async retiredCourseIds(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_retired_course_ids');
    if(error){
      if(error.code==='42883') return [];
      throw this.httpError(error,httpStatus);
    }
    return (data||[]).map(x=>typeof x==='string'?x:x?.course_id).filter(Boolean);
  }

  async adminRetireCourse(courseId){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_retire_course',{target_course_id:courseId});
    if(error) throw this.httpError(error,httpStatus);
    return data||{};
  }

  async adminRetiredCourses(){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_retired_courses');
    if(error) throw this.httpError(error,httpStatus);
    return data||[];
  }

  async adminRestoreCourse(courseId){
    this.requireUser();
    const {data,error,status:httpStatus}=await this.client.rpc('quizlab_admin_restore_course',{target_course_id:courseId});
    if(error) throw this.httpError(error,httpStatus);
    return Boolean(data);
  }

  async touchDevice(clientId,{push=false,pull=false}={}){
    const user=this.requireUser();
    if(!clientId) return;
    const now=new Date().toISOString();
    const row={user_id:user.id,client_id:clientId,last_seen:now};
    if(push) row.last_push_at=now;
    if(pull) row.last_pull_at=now;
    const {error,status:httpStatus}=await this.client
      .from('quizlab_devices')
      .upsert(row,{onConflict:'user_id,client_id'});
    if(error) throw this.httpError(error,httpStatus);
  }

  async pushChanges(payload={}){
    const token=this.operationToken();
    const ids=[...new Set([...(payload.dirtyCourseIds||[]),...(payload.dirtyBankCourseIds||[])])];
    const bankDirty=new Set(payload.dirtyBankCourseIds||[]);
    const courses=payload.courses||{};
    const pushed=[];
    for(const id of ids){
      this.assertOperation(token);
      if(!courses[id]) continue;
      pushed.push(await this.pushCourse(id,courses[id],{bankDirty:bankDirty.has(id)}));
    }
    await this.touchDevice(payload.clientId,{push:true});
    this.assertOperation(token);
    return {status:this.status,provider:this.provider,pushed:pushed.length,items:pushed};
  }

  async pullChanges(payload={}){
    const user=this.requireUser();
    const token=this.operationToken();
    const bankMetadata=await this.readSnapshotMetadata('quizlab_banks','id,course_id,subject,bank_revision,bank_hash,updated_at,managed_by_admin','owner_id',token);
    this.assertOperation(token);
    const banks=await this.hydrateSnapshotRows(bankMetadata||[],'bank',token,{prune:true,courses:payload.courses});
    const ids=(banks||[]).map(x=>x.id);
    let progress=[];
    if(ids.length){
      const data=await this.readSnapshotMetadata('quizlab_user_courses','bank_id,revision,updated_at','user_id',token);
      this.assertOperation(token);
      const owned=new Set(ids);
      progress=await this.hydrateSnapshotRows((data||[]).filter(row=>owned.has(row.bank_id)),'progress',token,{prune:true});
    }
    else this.snapshotCache(token).progress.clear();
    const progressByBank=new Map(progress.map(x=>[x.bank_id,x]));
    const courses=(banks||[]).map(bank=>{
      const p=progressByBank.get(bank.id);
      return {
        courseId:bank.course_id,
        subject:bank.subject,
        bank:bank.bank_json||{},
        bankRevision:Number(bank.bank_revision||0),bankUpdatedAt:bank.updated_at||null,
        managedByAdmin:!!bank.managed_by_admin,bankHash:bank.bank_hash||'',
        progress:p?.progress_json||{},
        revision:Number(p?.revision||0),
        updatedAt:p?.updated_at||bank.updated_at||null
      };
    });
    await this.touchDevice(payload.clientId,{pull:true});
    this.assertOperation(token);
    return {status:this.status,provider:this.provider,pulled:courses.length,courses};
  }

  async syncNow(payload={}){
    const token=this.operationToken();
    const blockedCourseIds=await this.blockedCourseIds();
    this.assertOperation(token);
    const retired=new Set(blockedCourseIds);
    const safePayload={
      ...payload,
      dirtyCourseIds:[...(payload.dirtyCourseIds||[])].filter(id=>!retired.has(id)),
      dirtyBankCourseIds:[...(payload.dirtyBankCourseIds||[])].filter(id=>!retired.has(id))
    };
    const dirtyIds=new Set(safePayload.dirtyCourseIds||[]);
    const push=await this.pushChanges(safePayload);
    this.assertOperation(token);
    const pull=await this.pullChanges(payload);
    this.assertOperation(token);
    if(Array.isArray(pull.courses)){
      pull.courses=pull.courses.filter(course=>!retired.has(course.courseId)&&!dirtyIds.has(course.courseId));
      const pushedCourses=(push.items||[]).filter(x=>x?.progress).map(x=>({
        courseId:x.courseId,
        subject:x.subject||safePayload.courses?.[x.courseId]?.subject||x.courseId,
        bank:x.bank||{},bankRevision:x.bankRevision,bankUpdatedAt:x.bankUpdatedAt,managedByAdmin:x.managedByAdmin,
        progress:x.progress,
        revision:Number(x.revision||0),
        updatedAt:x.progress?.updatedAt||null
      }));
      pull.courses=[...pull.courses,...pushedCourses];
      pull.pulled=pull.courses.length;
    }
    return {status:this.status,push,pull,blockedCourseIds};
  }
}
