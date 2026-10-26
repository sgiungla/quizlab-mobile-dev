/* Offline access is accepted only with a server-signed, account-bound lease. */
(() => {
  'use strict';
  if (globalThis.UniSgiunglaLicense) return;
  const cfg = globalThis.QUIZLAB_LAB_CONFIG || {};
  const PREFIX = 'unisgiunglalab.access.lease.v1.';
  const FEATURES = Object.freeze(['lessons','kit_ai','question_banks','handouts','quizlab_desktop','quizlab_pwa']);
  const HWM = PREFIX + 'clock';
  const RETRY_PREFIX = PREFIX + 'retry.';
  const CHECK_INTERVAL_MS = 60000;
  const REQUEST_TIMEOUT_MS = 8000;
  let current = null, userId = null, options = {}, pending = null, configured = false;
  let lastNetworkCheck = 0, lastError = '', clockHigh = 0, generation=0, emitted='';
  let retryState = {failures:0,nextRetryAt:0,lastStatus:0,unavailable:false};
  const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
  const store = {
    get: async key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: async (key, value) => { try { localStorage.setItem(key, value); } catch {} },
    remove: async key => { try { localStorage.removeItem(key); } catch {} }
  };
  const storage = () => options.storage || store;
  const emit = () => {const state=api.status(), signature=JSON.stringify([state.userId,state.allowed,state.status,state.features,state.licenseRevision,state.cloudUnavailable,state.lastStatus]);if(signature===emitted)return;emitted=signature;if(typeof dispatchEvent==='function'&&typeof CustomEvent==='function')dispatchEvent(new CustomEvent('unisgiungla-license-change',{detail:state}));};
  async function loadRetry(expected) {
    const empty={failures:0,nextRetryAt:0,lastStatus:0,unavailable:false};
    try {
      const value=JSON.parse(await storage().get(RETRY_PREFIX+expected) || 'null');
      if(value && Number.isSafeInteger(value.failures) && value.failures>=0 && value.failures<=20 && Number.isFinite(value.nextRetryAt) && value.nextRetryAt<=Date.now()+900000 && value.nextRetryAt>=0) {
        return {failures:value.failures,nextRetryAt:value.nextRetryAt,lastStatus:Number(value.lastStatus)||0,unavailable:value.unavailable===true};
      }
    } catch {}
    return empty;
  }
  async function requestLease() {
    // Abort the transport as well as releasing callers when a backend never replies.
    const controller=typeof AbortController==='function'?new AbortController():null;
    let timer;
    const request=Promise.resolve().then(()=>options.fetchLease({signal:controller?.signal}));
    if(typeof setTimeout!=='function')return request;
    try {
      return await Promise.race([request,new Promise((_,reject)=>{
        timer=setTimeout(()=>{controller?.abort();const error=new Error('Cloud non disponibile: verifica temporaneamente interrotta');error.code='CLOUD_TIMEOUT';error.status=0;reject(error);},REQUEST_TIMEOUT_MS);
      })]);
    } finally {if(timer!==undefined && typeof clearTimeout==='function')clearTimeout(timer);}
  }
  function canUseFeatures() {
    const now = Date.now();
    const liveUser = options.getUserId?.() || null;
    // A legacy global lease cannot prove selective permissions. Refresh online once after upgrading.
    if (!configured || !current || current.version !== 2 || liveUser !== userId || current.userId !== liveUser || current.status !== 'active') return false;
    // A substantial local clock rewind invalidates the offline lease.
    if (now + 60000 < clockHigh || now + 60000 < Date.parse(current.issuedAt)) return false;
    return now < Date.parse(current.validUntil);
  }
  function canUseFeature(feature) {
    return FEATURES.includes(feature) && canUseFeatures() && current.features.includes(feature);
  }
  async function checkFeature(feature) {
    if (!FEATURES.includes(feature)) return false;
    await checkAccess();
    return canUseFeature(feature);
  }
  async function verify(token, expectedUser) {
    if (!cfg.requireLicense || cfg.mode !== 'production' || !cfg.licensePublicKey) throw new Error('Verifica l’accesso al tuo account UniSgiunglaLab');
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Licenza non valida');
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Licenza non valida');
    const payloadBytes = bytes(parts[0]);
    const key = await crypto.subtle.importKey('spki', bytes(cfg.licensePublicKey), {name:'Ed25519'}, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, bytes(parts[1]), new TextEncoder().encode(parts[0]))) throw new Error('Firma della licenza non valida');
    const p = JSON.parse(new TextDecoder().decode(payloadBytes));
    const issued = Date.parse(p.issuedAt), until = Date.parse(p.validUntil);
    if (![1,2].includes(p.version) || p.userId !== expectedUser || !expectedUser || !Number.isFinite(issued) || !Number.isFinite(until) || until > issued + 86400000 || until < issued || !Number.isSafeInteger(p.licenseRevision) || p.licenseRevision < 1 || !['active','pending','suspended','expired'].includes(p.status)) throw new Error('Licenza non valida per questo account');
    if (p.version === 2 && (!Array.isArray(p.features) || p.features.length > FEATURES.length || new Set(p.features).size !== p.features.length || p.features.some(feature => !FEATURES.includes(feature)))) throw new Error('Licenza non valida: moduli non riconosciuti');
    return p;
  }
  async function refresh({force=true}={}) {
    if (pending) return pending;
    pending = (async () => {
      const expected = options.getUserId?.() || null;
      const requestGeneration=generation;
      const isCurrent=()=>requestGeneration===generation && (options.getUserId?.() || null)===expected;
      if (expected !== userId) {
        current=null;userId=expected;
        const retry=await loadRetry(expected);if(!isCurrent())return false;retryState=retry;
        if(expected) { try {const saved=await storage().get(PREFIX+expected);if(saved){const cached=await verify(saved,expected);if(isCurrent())current=cached;}} catch {} }
        emit();
      }
      if (!isCurrent() || !expected || typeof options.fetchLease !== 'function') return false;
      // Automatic feature gates respect a persisted circuit. An explicit user
      // check may retry immediately, but can never extend the signed deadline.
      if(!force && Date.now()<retryState.nextRetryAt){emit();return canUseFeatures();}
      let received=false;
      try {
        const response = await requestLease();
        received=true;
        if (!isCurrent()) return false;
        const p = await verify(response?.token, expected);
        if (!isCurrent()) return false;
        clockHigh = Math.max(Date.now(), Date.parse(p.issuedAt), clockHigh);
        current = p;
        lastNetworkCheck = Date.now(); lastError = '';
        retryState={failures:0,nextRetryAt:0,lastStatus:0,unavailable:false};
        await storage().set(PREFIX + expected, response.token);
        await storage().set(HWM, String(clockHigh));
        await storage().remove(RETRY_PREFIX+expected);
      } catch (error) {
        if(!isCurrent())return false;
        lastError = error?.message || String(error);
        // An authoritative denial or an invalid response must not extend an old lease.
        const authoritative=received || Number(error?.status)===401 || Number(error?.status)===403 || /Firma|Licenza non valida/.test(lastError);
        if (authoritative) {current=null;await storage().remove(PREFIX+expected);}
        const failures=Math.min(20,retryState.failures+1), status=Number(error?.status)||0;
        const delay=authoritative?CHECK_INTERVAL_MS:status===402?900000:Math.min(300000,30000*Math.pow(2,Math.min(5,failures-1)));
        retryState={failures,nextRetryAt:Date.now()+delay,lastStatus:status,unavailable:!authoritative};
        await storage().set(RETRY_PREFIX+expected,JSON.stringify(retryState));
      }
      emit(); return canUseFeatures();
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function configure(value) {
    const configureGeneration=++generation;
    options = value || {}; configured = true;
    userId = options.getUserId?.() || null; current = null;
    const expected=userId;
    lastNetworkCheck=0;lastError='';
    const retry=await loadRetry(expected);
    if(configureGeneration!==generation || (options.getUserId?.() || null)!==expected)return false;
    retryState=retry;
    clockHigh = Math.max(clockHigh, Number(await storage().get(HWM)) || 0);
    if (userId) {
      try {const token=await storage().get(PREFIX+expected);if(token){const cached=await verify(token,expected);if(configureGeneration===generation && (options.getUserId?.() || null)===expected)current=cached;}} catch (error) {if(configureGeneration===generation)lastError=error.message;}
    }
    emit(); return canUseFeatures();
  }
  async function checkAccess() {
    if ((options.getUserId?.() || null) !== userId || !canUseFeatures() || Date.now() - lastNetworkCheck > CHECK_INTERVAL_MS) await refresh({force:false});
    if (canUseFeatures()) { clockHigh = Math.max(clockHigh, Date.now()); await storage().set(HWM, String(clockHigh)); }
    return canUseFeatures();
  }
  const api = globalThis.UniSgiunglaLicense = {
    configure, refresh, checkAccess, canUseFeatures, canUseFeature, checkFeature, verify,
    status: () => ({userId,allowed:canUseFeatures(),isAdmin:canUseFeatures()&&current?.isAdmin===true,status:current?.status || 'unverified',features:current?.version===2?[...current.features]:[],licenseRevision:current?.licenseRevision||0,requiresOnlineUpgrade:current?.version===1,validUntil:current?.validUntil || null,lastError,lastStatus:retryState.lastStatus,cloudUnavailable:retryState.unavailable,nextRetryAt:retryState.nextRetryAt?new Date(retryState.nextRetryAt).toISOString():null}),
    clear: async () => {generation++;const old=userId;current=null;userId=null;retryState={failures:0,nextRetryAt:0,lastStatus:0,unavailable:false};emit();if(old){await storage().remove(PREFIX+old);await storage().remove(RETRY_PREFIX+old);}}
  };
  if (typeof addEventListener === 'function') {
    addEventListener('online', () => configured && refresh({force:false}));
    addEventListener('focus', () => configured && checkAccess());
    setInterval(() => { if (configured) { emit(); checkAccess(); } }, 30000);
  }
  // Content scripts and extension popup use the background's verified account.
  if (typeof document !== 'undefined' && globalThis.chrome?.runtime?.id) {
    let desktopUser = null, desktopIdentity=null, bootstrapGeneration=0;
    const chromeStore = {
      get: async key => (await chrome.storage.local.get(key))[key] || null,
      set: async (key,value) => chrome.storage.local.set({[key]:value}),
      remove: async key => chrome.storage.local.remove(key)
    };
    async function bootstrap() {
      const run=++bootstrapGeneration;
      try {
        const result = await chrome.runtime.sendMessage({type:'QUIZLAB_LICENSE_STATUS'});
        if(run!==bootstrapGeneration)return;
        desktopIdentity=await chromeStore.get('unisgiunglalab.quizlab.desktop.identity.v1');
        if(run!==bootstrapGeneration)return;
        desktopUser = result?.userId || null;
        await configure({getUserId:()=>desktopUser, storage:chromeStore, fetchLease:async()=> {
          const r = await chrome.runtime.sendMessage({type:'QUIZLAB_LICENSE_STATUS',refresh:true});
          if (r?.userId !== desktopUser) { desktopUser=r?.userId || null; throw new Error('Account cambiato, ripetere la verifica'); }
          if (!r?.token) {const error=new Error(r?.error || r?.lastError || 'Verifica locale non disponibile');if(r?.cloudUnavailable)error.status=Number(r?.lastStatus)||0;else if(r?.ok===true && r?.allowed===false)error.status=403;throw error;}
          return r;
        }});
        if(run!==bootstrapGeneration)return;
        if (result?.token) await refresh({force:false});
        else if (!result?.allowed && !result?.cloudUnavailable) await api.clear();
      } catch (error) {if(run===bootstrapGeneration){lastError=error.message;emit();}}
    }
    bootstrap();
    chrome.storage.onChanged.addListener((changes,area) => {
      if (area==='local' && (changes['unisgiunglalab.quizlab.desktop.cloud.session.v1'] || changes['unisgiunglalab.quizlab.desktop.identity.v1'])) {
        const sessionChange=changes['unisgiunglalab.quizlab.desktop.cloud.session.v1'];
        const identityChange=changes['unisgiunglalab.quizlab.desktop.identity.v1'];
        if(identityChange)desktopIdentity=identityChange.newValue||null;
        if ((sessionChange?.newValue && sessionChange.newValue.user?.id!==desktopUser) || (sessionChange&&!sessionChange.newValue&&desktopIdentity?.user?.id!==desktopUser) || (identityChange && !identityChange.newValue)) {desktopUser=null;api.clear();}
        bootstrap();
      }
    });
  }
})();
