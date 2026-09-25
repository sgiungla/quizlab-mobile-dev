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

  progressPayload(course={}){
    return {
      attempts:Array.isArray(course.attempts)?course.attempts:[],
      exams:Array.isArray(course.exams)?course.exams:[],
      marked:Array.isArray(course.marked)?course.marked:[],
      pendingReview:Array.isArray(course.pendingReview)?course.pendingReview:[],
      historicalWrong:Array.isArray(course.historicalWrong)?course.historicalWrong:[],
      fullCampaign:course.fullCampaign||{signature:'all',seenIds:[],resetAt:null},
      createdAt:course.createdAt||null,
      updatedAt:course.updatedAt||null
    };
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
      .select('revision')
      .eq('user_id',user.id)
      .eq('bank_id',bank.id)
      .maybeSingle();
    if(revError) throw revError;
    const revision=Number(existing?.revision||0)+1;

    const {error:progressError}=await this.client
      .from('quizlab_user_courses')
      .upsert({
        user_id:user.id,
        bank_id:bank.id,
        progress_json:this.progressPayload(course),
        revision,
        updated_at:now
      },{onConflict:'user_id,bank_id'});
    if(progressError) throw progressError;
    return {courseId,bankId:bank.id,revision};
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
    const dirtyIds=new Set(payload.dirtyCourseIds||[]);
    const push=await this.pushChanges(payload);
    const pull=await this.pullChanges(payload);
    if(dirtyIds.size && Array.isArray(pull.courses)){
      pull.courses=pull.courses.filter(course=>!dirtyIds.has(course.courseId));
      pull.pulled=pull.courses.length;
    }
    return {status:this.status,push,pull};
  }
}
