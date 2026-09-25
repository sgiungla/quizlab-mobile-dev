export class LocalOnlySyncAdapter {
  constructor(){
    this.status='local-only';
    this.provider='none';
  }

  async start(context={}){
    return {
      status:this.status,
      provider:this.provider,
      online:navigator.onLine,
      ownerId:context.ownerId||null
    };
  }

  async pushChanges(payload={}){
    return {
      status:this.status,
      provider:this.provider,
      pushed:0,
      deferred:true,
      reason:'cloud-not-configured',
      dirtyCourseIds:[...(payload.dirtyCourseIds||[])]
    };
  }

  async pullChanges(){
    return {
      status:this.status,
      provider:this.provider,
      pulled:0,
      deferred:true,
      reason:'cloud-not-configured'
    };
  }

  async syncNow(payload={}){
    const [push,pull]=await Promise.all([
      this.pushChanges(payload),
      this.pullChanges()
    ]);
    return {status:this.status,push,pull};
  }
}
