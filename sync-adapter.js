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
    const user=this.user();
    if(!this.client||!user) throw new Error('Accesso richiesto');
    const row={
      user_id:user.id,
      display_name:profile.displayName||'',
      avatar_url:null,
      motto:profile.motto||'La giungla universitaria è sotto controllo.',
      updated_at:new Date().toISOString()
    };
    const {error}=await this.client.from('quizlab_profiles').upsert(row,{onConflict:'user_id'});
    if(error) throw error;
  }

  async pushChanges(payload={}){
    return {status:this.status,provider:this.provider,pushed:0,deferred:true,reason:'sync-phase-not-enabled',dirtyCourseIds:[...(payload.dirtyCourseIds||[])]};
  }

  async pullChanges(){
    return {status:this.status,provider:this.provider,pulled:0,deferred:true,reason:'sync-phase-not-enabled'};
  }

  async syncNow(payload={}){
    const [push,pull]=await Promise.all([this.pushChanges(payload),this.pullChanges()]);
    return {status:this.status,push,pull};
  }
}
