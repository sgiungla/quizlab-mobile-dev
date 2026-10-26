// Queries are fixed in server modules. No SQL or RPC name comes from HTTP input.
export function wrapDatabase(sql,onMeasure=()=>{}){
 return {
  async query(query,args=[]){
   // Postgres.js serializes JSON parameters itself. The reused engine supplies
   // JSON text for PGlite: decode only explicitly typed JSON arguments first,
   // otherwise the driver would store a JSON string instead of an object.
   const values=args.map((value,index)=>typeof value==='string'&&new RegExp('\\$'+(index+1)+'\\s*::\\s*jsonb\\b').test(query)?JSON.parse(value):value);
   const rows=await sql.unsafe(query,values);onMeasure(new TextEncoder().encode(JSON.stringify(rows)).byteLength);return{rows:[...rows]};},
  transaction:fn=>sql.begin(tx=>fn(wrapDatabase(tx,onMeasure)))
 };
}
export function createAdapter(db){
 return {db,async rpc(user,name){
  if(!['quizlab_is_admin','quizlab_license_status'].includes(name))throw Error('Server RPC not allowed');
  return db.transaction(async tx=>{
   await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role:'authenticated'})]);
   await tx.query('set local role authenticated');
   return(await tx.query('select public.'+name+'() as value')).rows[0].value;
  });
 }};
}
