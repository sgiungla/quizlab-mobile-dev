export class LocalOnlySyncAdapter {
  constructor(){ this.status='local-only'; }
  async start(){ return {status:this.status}; }
  async pushChanges(){ return {status:this.status,pushed:0}; }
  async pullChanges(){ return {status:this.status,pulled:0}; }
}
