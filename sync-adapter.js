export class QuizLabSyncAdapter {
  constructor(){
    this.status='local-only';
    this.provider='supabase';
    this.client=null;
    this.session=null;
    this.authSubscription=null;
  }

  configured(settings={}){
    return Boolean(settings?.supabaseUrl && settings?.supabasePublishableKey);
  }

  async start(context={}){
    const settings=context.settings||{};
    if(!this.configured(settings) || !globalThis.supabase?.createClient){
      this.status='local-only';
      return {status:this.status,provider:this.provider,online:navigator.onLine,user:null};
    }
    this.client=globalThis.supabase.createClient(
      settings.supabaseUrl,
      settings.supabasePublishableKey,
      {auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}
    );
    const {data,error}=await this.client.auth.getSession();
    if(error) throw error;
    this.session=data?.session||null;
    this.status=this.session?'cloud-online':'cloud-ready';
    const {data:listener}=this.client.auth.onAuthStateChange((event,session)=>{
      this.session=session||null;
      this.status=this.session?'cloud-online':'cloud-ready';
      context.onAuthChange?.({event,session:this.session,status:this.status});
    });
    this.authSubscription=listener?.subscription||null;
    return {status:this.status,provider:this.provider,online:navigator.onLine,user:this.session?.user||null};
  }

  user(){ return this.session?.user||null; }

  requireUser(){
    const user=this.user();
    if(!this.client||!user) throw new Error('Accesso cloud richiesto');
    return user;
  }

  async signUp(email,password,redirectTo){
    if(!this.client) throw new Error('Cloud non configurato');
    return this.client.auth.signUp({email,password,options:{emailRedirectTo:redirectTo}});
  }

  async signIn(email,password){
    if(!this.client) throw new Error('Cloud non configurato');
    return this.client.auth.signInWithPassword({email,password});
  }

  async signOut(){
    if(!this.client) return;
    const {error}=await this.client.auth.signOut();
    if(error) throw error;
  }

  async upsertProfile(profile={}){
    const user=this.requireUser();
    const row={
      user_id:user.id,
      display_name:profile.displayName||'',
      avatar_url:profile.avatarPath||null,
      motto:profile.motto||'La giungla universitaria è sotto controllo.',
      updated_at:new Date().toISOString()
    };
    const {error}=await this.client.from('quizlab_profiles').upsert(row,{onConflict:'user_id'});
    if(error) throw error;
  }

  async uploadAvatar(file){
    const user=this.requireUser();
    if(!file) throw new Error('Nessun file selezionato');
    const type=String(file.type||'').toLowerCase();
    if(!['image/jpeg','image/png','image/webp','image/gif'].includes(type)) throw new Error('Formato immagine non supportato');
    if(file.size>2.5*1024*1024) throw new Error('Foto troppo grande: massimo 2,5 MB');
    const ext=type==='image/png'?'png':type==='image/webp'?'webp':type==='image/gif'?'gif':'jpg';
    const path=user.id+'/avatar.'+ext;
    const {error}=await this.client.storage.from('quizlab-avatars').upload(path,file,{
      cacheControl:'3600',
      upsert:true,
      contentType:type
    });
    if(error) throw error;
    return path;
  }

  async signedAvatarUrl(path){
    if(!path)return '';
    const {data,error}=await this.client.storage.from('quizlab-avatars').createSignedUrl(path,60*60*24*7);
    if(error) throw error;
    return data?.signedUrl||'';
  }

  async pullProfile(){
    const user=this.requireUser();
    const {data,error}=await this.client
      .from('quizlab_profiles')
      .select('display_name,avatar_url,motto,updated_at')
      .eq('user_id',user.id)
      .maybeSingle();
    if(error) throw error;
    if(!data)return null;
    let avatar_signed_url='';
    if(data.avatar_url){
      try{avatar_signed_url=await this.signedAvatarUrl(data.avatar_url);}catch(e){console.warn('Avatar signed URL',e);}
    }
    return {...data,avatar_signed_url};
  }

  async accessState(){
    this.requireUser();
    const {data:status,error:statusError}=await this.client.rpc('quizlab_account_status');
    if(statusError){
      if(statusError.code==='42883') return {status:'active',isAdmin:false,legacy:true};
      throw statusError;
    }
    const {data:isAdmin,error:adminError}=await this.client.rpc('quizlab_is_admin');
    if(adminError) throw adminError;
    return {status:status||'pending',isAdmin:Boolean(isAdmin)};
  }

  async ensurePendingRegistration(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_register_pending_user');
    if(error){
      if(error.code==='42883') return 'active';
      throw error;
    }
    return data||'pending';
  }

  async adminUserOverview(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_user_overview');
    if(error) throw error;
    return data||[];
  }

  async adminStorageOverview(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_storage_overview');
    if(error) throw error;
    return Array.isArray(data)?(data[0]||null):data;
  }

  async adminUserCourseStats(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_user_course_stats');
    if(error) throw error;
    return data||[];
  }

  async adminSetUserStatus(userId,status){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_set_user_status',{target_user:userId,new_status:status});
    if(error) throw error;
    return data;
  }

  bankPayload(course={}){
    return {
      officialBank:Array.isArray(course.officialBank)?course.officialBank:[],
      aiBank:Array.isArray(course.aiBank)?course.aiBank:[],
      topicMap:course.topicMap??null,
      aiWorkflow:course.aiWorkflow||{},
      createdAt:course.createdAt||null,
      updatedAt:course.updatedAt||null
    };
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
      version:2,
      performanceResetAt:rawMeta.performanceResetAt||null,
      reviewResetAt:rawMeta.reviewResetAt||null,
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

  mergeEvents(a=[],b=[],kind,resetAt=null){
    const map=new Map();
    for(const raw of [...a,...b]){
      const e={...raw,eventId:this.eventId(kind,raw)};
      const key=e.eventId;
      const prev=map.get(key);
      if(!prev||String(e.at||'')>=String(prev.at||''))map.set(key,e);
    }
    return [...map.values()]
      .filter(e=>!resetAt||!e.at||String(e.at)>=String(resetAt))
      .sort((x,y)=>String(x.at||'').localeCompare(String(y.at||'')));
  }

  mergeProgress(localProgress={},remoteProgress={}){
    const a=this.normalizeProgress(localProgress);
    const b=this.normalizeProgress(remoteProgress);
    const performanceResetAt=this.maxIso(a.syncMeta.performanceResetAt,b.syncMeta.performanceResetAt);
    const reviewResetAt=this.maxIso(a.syncMeta.reviewResetAt,b.syncMeta.reviewResetAt);
    const attempts=this.mergeEvents(a.attempts,b.attempts,'attempt',performanceResetAt);
    const exams=this.mergeEvents(a.exams,b.exams,'exam',performanceResetAt);
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
      }else if(e.correct===true&&e.mode==='review'){
        const prev=pendingState[e.questionId];
        if(!prev||String(e.at)>=String(prev.at||''))pendingState[e.questionId]={value:false,at:e.at};
      }
    }

    const marked=Object.entries(markedState)
      .filter(([,v])=>v.value&&(!reviewResetAt||!v.at||String(v.at)>=String(reviewResetAt)))
      .map(([id])=>id);
    const pendingReview=Object.entries(pendingState)
      .filter(([,v])=>v.value&&(!reviewResetAt||!v.at||String(v.at)>=String(reviewResetAt)))
      .map(([id])=>id);
    const historicalWrong=Object.entries(historicalWrongAt)
      .filter(([,at])=>!reviewResetAt||!at||String(at)>=String(reviewResetAt))
      .map(([id])=>id);

    const fullResetAt=this.maxIso(a.fullCampaign.resetAt,b.fullCampaign.resetAt);
    for(const e of attempts){
      if(e.mode==='full'&&e.questionId&&e.at&&(!fullResetAt||String(e.at)>=String(fullResetAt))){
        if(!fullSeenAt[e.questionId]||String(e.at)>=String(fullSeenAt[e.questionId]))fullSeenAt[e.questionId]=e.at;
      }
    }
    const seenIds=Object.entries(fullSeenAt)
      .filter(([,at])=>!fullResetAt||!at||String(at)>=String(fullResetAt))
      .map(([id])=>id);

    return {
      attempts,exams,marked,pendingReview,historicalWrong,
      fullCampaign:{signature:'all',seenIds,resetAt:fullResetAt},
      syncMeta:{version:2,performanceResetAt,reviewResetAt,markedState,pendingState,historicalWrongAt,fullSeenAt},
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
    const {data,error}=await this.client.rpc('quizlab_save_progress_v2',{
      target_bank_id:bankId,
      expected_revision:Number(expectedRevision||0),
      incoming_progress:progress
    });
    if(error){
      if(error.code==='42883')return {legacy:true};
      throw error;
    }
    return data||{};
  }

  async pushCourse(courseId,course={},options={}){
    const user=this.requireUser();
    const now=new Date().toISOString();
    let bank=null;
    if(options.bankDirty){
      const bankRow={
        owner_id:user.id,
        course_id:courseId,
        subject:course.subject||courseId,
        bank_json:this.bankPayload(course),
        is_shared:false,
        updated_at:now
      };
      const {data,error}=await this.client
        .from('quizlab_banks')
        .upsert(bankRow,{onConflict:'owner_id,course_id'})
        .select('id')
        .single();
      if(error) throw error;
      bank=data;
    }else{
      const {data,error}=await this.client
        .from('quizlab_banks')
        .select('id')
        .eq('owner_id',user.id)
        .eq('course_id',courseId)
        .maybeSingle();
      if(error) throw error;
      if(data) bank=data;
      else return this.pushCourse(courseId,course,{bankDirty:true});
    }

    const {data:existing,error:revError}=await this.client
      .from('quizlab_user_courses')
      .select('revision,progress_json')
      .eq('user_id',user.id)
      .eq('bank_id',bank.id)
      .maybeSingle();
    if(revError) throw revError;

    let expectedRevision=Number(existing?.revision||0);
    let progress=this.progressPayload(course);

    for(let attempt=0;attempt<5;attempt++){
      const out=await this.saveProgressAtomic(bank.id,expectedRevision,progress);

      if(out.legacy){
        const revision=expectedRevision+1;
        const {error:progressError}=await this.client
          .from('quizlab_user_courses')
          .upsert({
            user_id:user.id,
            bank_id:bank.id,
            progress_json:progress,
            revision,
            updated_at:now
          },{onConflict:'user_id,bank_id'});
        if(progressError) throw progressError;
        return {courseId,bankId:bank.id,revision,progress,legacy:true};
      }

      if(out.ok){
        return {
          courseId,
          bankId:bank.id,
          revision:Number(out.revision||expectedRevision+1),
          progress:this.normalizeProgress(out.progress||progress),
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
    const {data,error}=await this.client.rpc('quizlab_delete_my_course',{target_course_id:courseId});
    if(error) throw error;
    return data||{course_id:courseId,deleted_banks:0};
  }

  async restoreMyCourse(courseId){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_restore_my_course',{target_course_id:courseId});
    if(error) throw error;
    return Boolean(data);
  }

  async blockedCourseIds(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_blocked_course_ids');
    if(error){
      if(error.code==='42883') return [];
      throw error;
    }
    return (data||[]).map(x=>typeof x==='string'?x:x?.course_id).filter(Boolean);
  }

  async retiredCourseIds(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_retired_course_ids');
    if(error){
      if(error.code==='42883') return [];
      throw error;
    }
    return (data||[]).map(x=>typeof x==='string'?x:x?.course_id).filter(Boolean);
  }

  async adminRetireCourse(courseId){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_retire_course',{target_course_id:courseId});
    if(error) throw error;
    return data||{};
  }

  async adminRetiredCourses(){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_retired_courses');
    if(error) throw error;
    return data||[];
  }

  async adminRestoreCourse(courseId){
    this.requireUser();
    const {data,error}=await this.client.rpc('quizlab_admin_restore_course',{target_course_id:courseId});
    if(error) throw error;
    return Boolean(data);
  }

  async touchDevice(clientId,{push=false,pull=false}={}){
    const user=this.requireUser();
    if(!clientId) return;
    const now=new Date().toISOString();
    const row={user_id:user.id,client_id:clientId,last_seen:now};
    if(push) row.last_push_at=now;
    if(pull) row.last_pull_at=now;
    const {error}=await this.client
      .from('quizlab_devices')
      .upsert(row,{onConflict:'user_id,client_id'});
    if(error) throw error;
  }

  async pushChanges(payload={}){
    const ids=[...(payload.dirtyCourseIds||[])];
    const bankDirty=new Set(payload.dirtyBankCourseIds||[]);
    const courses=payload.courses||{};
    const pushed=[];
    for(const id of ids){
      if(!courses[id]) continue;
      pushed.push(await this.pushCourse(id,courses[id],{bankDirty:bankDirty.has(id)}));
    }
    await this.touchDevice(payload.clientId,{push:true});
    return {status:this.status,provider:this.provider,pushed:pushed.length,items:pushed};
  }

  async pullChanges(payload={}){
    const user=this.requireUser();
    const {data:banks,error:bankError}=await this.client
      .from('quizlab_banks')
      .select('id,course_id,subject,bank_json,updated_at')
      .eq('owner_id',user.id);
    if(bankError) throw bankError;
    const ids=(banks||[]).map(x=>x.id);
    let progress=[];
    if(ids.length){
      const {data,error}=await this.client
        .from('quizlab_user_courses')
        .select('bank_id,progress_json,revision,updated_at')
        .eq('user_id',user.id)
        .in('bank_id',ids);
      if(error) throw error;
      progress=data||[];
    }
    const progressByBank=new Map(progress.map(x=>[x.bank_id,x]));
    const courses=(banks||[]).map(bank=>{
      const p=progressByBank.get(bank.id);
      return {
        courseId:bank.course_id,
        subject:bank.subject,
        bank:bank.bank_json||{},
        progress:p?.progress_json||{},
        revision:Number(p?.revision||0),
        updatedAt:p?.updated_at||bank.updated_at||null
      };
    });
    await this.touchDevice(payload.clientId,{pull:true});
    return {status:this.status,provider:this.provider,pulled:courses.length,courses};
  }

  async syncNow(payload={}){
    const blockedCourseIds=await this.blockedCourseIds();
    const retired=new Set(blockedCourseIds);
    const safePayload={
      ...payload,
      dirtyCourseIds:[...(payload.dirtyCourseIds||[])].filter(id=>!retired.has(id)),
      dirtyBankCourseIds:[...(payload.dirtyBankCourseIds||[])].filter(id=>!retired.has(id))
    };
    const dirtyIds=new Set(safePayload.dirtyCourseIds||[]);
    const push=await this.pushChanges(safePayload);
    const pull=await this.pullChanges(payload);
    if(Array.isArray(pull.courses)){
      pull.courses=pull.courses.filter(course=>!retired.has(course.courseId)&&!dirtyIds.has(course.courseId));
      const pushedCourses=(push.items||[]).filter(x=>x?.progress).map(x=>({
        courseId:x.courseId,
        subject:safePayload.courses?.[x.courseId]?.subject||x.courseId,
        bank:{},
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
