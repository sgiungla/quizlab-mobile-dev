import {Buffer} from 'node:buffer';
import {createHmac,createHash,timingSafeEqual,randomUUID} from 'node:crypto';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const money=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<0||n>1000000000)throw fail(400,'Importo non valido');return n;};
const dto=o=>{
 const issues=Object.values(o.payment_issues||{}).sort((a,b)=>Number(a.installment)-Number(b.installment));
 return {order_id:o.order_id,user_id:o.user_id,user_email:o.user_email||null,kind:o.kind,item_id:o.item_id,snapshot:o.snapshot,status:o.status,contract_id:o.contract_id,fulfillment:o.fulfillment,
  payment_issue:issues.length?{...issues[0],pending_count:issues.length}:null,created_at:o.created_at instanceof Date?o.created_at.toISOString():o.created_at,provider:'local-simulator',noRealCharge:true};
};
const uuid=v=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v)))throw fail(400,'Identificativo richiesta non valido');return v;};

export function signTestEvent(bytes,secret,timestamp=Math.floor(Date.now()/1000)){
 return `t=${timestamp},v1=${createHmac('sha256',secret).update(String(timestamp)+'.').update(bytes).digest('hex')}`;
}
export function verifyTestEvent(bytes,header,secret,now=Date.now()){
 const parts=String(header||'').split(','),times=parts.filter(x=>x.startsWith('t='));
 if(times.length!==1)throw fail(400,'Firma evento non valida');
 const stamp=Number(times[0].slice(2));
 if(!Number.isInteger(stamp)||Math.abs(now/1000-stamp)>300)throw fail(400,'Firma evento scaduta');
 const expected=createHmac('sha256',secret).update(String(stamp)+'.').update(bytes).digest();
 if(!parts.filter(x=>/^v1=[0-9a-f]{64}$/.test(x)).some(x=>timingSafeEqual(expected,Buffer.from(x.slice(3),'hex'))))throw fail(400,'Firma evento non valida');
 let event;try{event=JSON.parse(bytes.toString('utf8'));}catch{throw fail(400,'Evento non valido');}
 if(event?.livemode!==false)throw fail(403,'Sono accettati esclusivamente eventi simulati');
 return event;
}

export function createLocalCommerce({lab,secret}){
 const db=lab.db;
 async function admin(userId){if(!await lab.rpc(userId,'quizlab_is_admin'))throw fail(403,'Accesso amministratore richiesto');}
 async function catalog(){
  const plans=(await db.query('select plan_id,label,duration_months,currency,total_cents,payment_mode,installment_count,modules,version from public.quizlab_plans where active order by duration_months,plan_id')).rows;
  const products=(await db.query(`select p.product_id,p.label,p.total_cents,p.currency,p.version from public.quizlab_shop_products p join public.quizlab_banks b on b.id=p.source_bank_id
   where p.active and exists(select 1 from public.quizlab_admins a where a.user_id=b.owner_id) and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=b.course_id) order by p.label`)).rows;
  return {mode:'simulation',provider:'local-simulator',noRealCharge:true,plans,products};
 }
 async function createOrder(userId,input){
  uuid(input.request_id);if(!['plan','course'].includes(input.kind)||typeof input.item_id!=='string')throw fail(400,'Articolo non valido');
  if(await lab.rpc(userId,'quizlab_is_admin'))throw fail(400,'Per gli acquisti usa un account destinatario, non amministratore');
  return db.transaction(async tx=>{
   const old=(await tx.query('select * from public.quizlab_shop_orders where user_id=$1 and request_id=$2',[userId,input.request_id])).rows[0];
   if(old){if(old.kind!==input.kind||old.item_id!==input.item_id)throw fail(409,'Richiesta riutilizzata per un altro acquisto');return dto(old);}
   const access=(await tx.query('select * from public.quizlab_user_access where user_id=$1',[userId])).rows[0];
   if(!access||access.status==='suspended')throw fail(403,'Account non disponibile per acquisti');
   let snapshot,bank=null;
   if(input.kind==='plan'){
    snapshot=(await tx.query('select * from public.quizlab_plans where plan_id=$1 and active',[input.item_id])).rows[0];
    if(!snapshot)throw fail(404,'Piano non disponibile');
    snapshot={...snapshot,total_cents:money(snapshot.total_cents)};delete snapshot.updated_at;
   }else{
    const p=(await tx.query(`select p.*,b.course_id,b.subject,b.bank_json,b.owner_id from public.quizlab_shop_products p join public.quizlab_banks b on b.id=p.source_bank_id
     where p.product_id=$1 and p.active and exists(select 1 from public.quizlab_admins a where a.user_id=b.owner_id) and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=b.course_id)`,[input.item_id])).rows[0];
    if(!p)throw fail(404,'Materia non disponibile');
    snapshot={product_id:p.product_id,label:p.label,total_cents:money(p.total_cents),currency:p.currency,version:p.version,course_id:p.course_id,subject:p.subject,source_bank_id:p.source_bank_id};bank=p.bank_json;
   }
   if(input.expected_version!==undefined&&Number(input.expected_version)!==Number(snapshot.version))throw fail(409,'Offerta aggiornata: controlla il nuovo riepilogo');
   const orderId=randomUUID(),sessionId='cs_test_lab_'+randomUUID().replaceAll('-','');
   const order=(await tx.query(`insert into public.quizlab_shop_orders(order_id,user_id,request_id,kind,item_id,snapshot,source_bank,expected_license_revision,provider_session_id)
    values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) returning *`,[orderId,userId,input.request_id,input.kind,input.item_id,JSON.stringify(snapshot),bank?JSON.stringify(bank):null,access.license_revision,sessionId])).rows[0];
   return dto(order);
  });
 }
 async function orders(userId,{all=false,offset=0}={}){
  if(all)await admin(userId);offset=Number(offset);if(!Number.isSafeInteger(offset)||offset<0)throw fail(400,'Pagina non valida');
  return (await db.query('select o.*,u.email as user_email from public.quizlab_shop_orders o join auth.users u on u.id=o.user_id '+(all?'':'where o.user_id=$1 ')+`order by o.created_at desc limit 25 offset $${all?1:2}`,all?[offset]:[userId,offset])).rows.map(dto);
 }
 async function library(userId){await admin(userId);return (await db.query(`select id,course_id,subject,bank_revision from public.quizlab_banks where owner_id=$1 and not exists(select 1 from public.quizlab_retired_courses r where r.course_id=quizlab_banks.course_id) order by subject`,[userId])).rows;}
 async function products(userId){await admin(userId);return (await db.query('select * from public.quizlab_shop_products order by label')).rows;}
 async function saveProduct(userId,input){
  await admin(userId);if(!/^[a-zA-Z0-9_-]{1,64}$/.test(input.product_id||'')||['__proto__','constructor','prototype'].includes(input.product_id)||typeof input.label!=='string'||!input.label.trim()||input.label.length>120||typeof input.active!=='boolean')throw fail(400,'Dati materia non validi');
  const cents=money(input.total_cents);uuid(input.source_bank_id);
  return db.transaction(async tx=>{
   const bank=(await tx.query('select id from public.quizlab_banks where id=$1 and owner_id=$2',[input.source_bank_id,userId])).rows[0];if(!bank)throw fail(403,'Scegli una tua materia amministratore');
   const prior=(await tx.query('select * from public.quizlab_shop_products where product_id=$1 for update',[input.product_id])).rows[0];if(Number(prior?.version||0)!==Number(input.expected_version))throw fail(409,'La materia in vendita è cambiata: aggiorna il riepilogo');
   return (await tx.query(`insert into public.quizlab_shop_products(product_id,label,total_cents,source_bank_id,active)values($1,$2,$3,$4,$5)
    on conflict(product_id)do update set label=excluded.label,total_cents=excluded.total_cents,source_bank_id=excluded.source_bank_id,active=excluded.active,version=quizlab_shop_products.version+1,updated_at=now() returning *`,[input.product_id,input.label.trim(),cents,input.source_bank_id,input.active])).rows[0];
  });
 }
 async function apply(tx,order,actorId,{review=false}={}){
  if(order.status==='fulfilled')return dto(order);
  const access=(await tx.query('select * from public.quizlab_user_access where user_id=$1 for update',[order.user_id])).rows[0];
  if(!access||access.status!=='active')return {reason:'approval_required'};
  if(!review&&Number(access.license_revision)!==Number(order.expected_license_revision))return {reason:'access_changed'};
  await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actorId]);
  let fulfillment,contractId=null;
  if(order.kind==='plan'){
   const snapshot=order.snapshot,prior=(await tx.query('select plan_snapshot from public.quizlab_contracts where contract_id=$1',[access.current_contract_id])).rows[0];
   // Different paid packages require admin review; never silently downgrade another contract.
   if(!review&&prior&&prior.plan_snapshot.plan_id!==snapshot.plan_id)return {reason:'different_plan_requires_review'};
   const action=prior&&prior.plan_snapshot.plan_id===snapshot.plan_id?'renew':'activate';
   const start=(await tx.query('select case when $1 then greatest(now(),$2::timestamptz) else now() end as start',[action==='renew',access.expires_at])).rows[0].start;
   const end=(await tx.query('select public.quizlab_add_utc_months($1::timestamptz,$2::integer) as stop',[start,snapshot.duration_months])).rows[0].stop;
   contractId=randomUUID();
   await tx.query('insert into public.quizlab_contracts(contract_id,user_id,plan_snapshot,starts_at,ends_at,action,actor_id)values($1,$2,$3::jsonb,$4,$5,$6,$7)',[contractId,order.user_id,JSON.stringify(snapshot),start,end,action,actorId]);
   const parts=snapshot.payment_mode==='installments'?snapshot.installment_count:1;
   for(let i=1;i<=parts;i++)await tx.query(`insert into public.quizlab_installments(contract_id,number,due_at,amount_cents,currency,status,paid_at)values($1,$2,public.quizlab_add_utc_months($3::timestamptz,$4),$5,$6,$7,case when $7='paid' then now() else null end)`,[contractId,i,start,i-1,Math.floor(snapshot.total_cents/parts)+(i<=snapshot.total_cents%parts?1:0),snapshot.currency,i===1?'paid':'scheduled']);
   await tx.query(`update public.quizlab_user_access set starts_at=case when $2='renew' and expires_at>now() then starts_at else $3 end,expires_at=$4,current_contract_id=$5,license_revision=license_revision+1,updated_at=now() where user_id=$1`,[order.user_id,action,start,end,contractId]);
   fulfillment={action,starts_at:start,ends_at:end,modules:snapshot.modules,installments:parts,previous_contract_id:access.current_contract_id||null};
  }else{
   if(access.starts_at&&Date.parse(access.starts_at)>Date.now())return {reason:'access_not_started'};
   if((await tx.query('select 1 from public.quizlab_retired_courses where course_id=$1',[order.snapshot.course_id])).rows.length)return {reason:'course_retired'};
   const source=(await tx.query(`select b.id from public.quizlab_banks b where b.id=$1 and b.course_id=$2
    and exists(select 1 from public.quizlab_admins a where a.user_id=b.owner_id)`,[order.snapshot.source_bank_id,order.snapshot.course_id])).rows[0];
   if(!source)return {reason:'source_not_available'};
   const allowed=(await tx.query("select (public.quizlab_effective_modules_for($1)->>'quizlab_desktop')::boolean or (public.quizlab_effective_modules_for($1)->>'quizlab_pwa')::boolean as ok",[order.user_id])).rows[0].ok;
   if(!allowed||access.expires_at&&Date.parse(access.expires_at)<=Date.now())return {reason:'quizlab_access_required'};
   const existing=(await tx.query('select * from public.quizlab_banks where owner_id=$1 and course_id=$2',[order.user_id,order.snapshot.course_id])).rows[0];
   if(existing)return {reason:'existing_course_requires_manual_assignment'};
   const result=(await tx.query('select public.quizlab_admin_assign_course_safe($1,$2,$3,$4::jsonb,0::bigint,\'create\',$2,$5) as value',[order.user_id,order.snapshot.course_id,order.snapshot.subject,JSON.stringify(order.source_bank),order.order_id])).rows[0].value;
   if(!result.ok)return {reason:result.reason||'assignment_conflict'};
   fulfillment={course_id:order.snapshot.course_id,bank_revision:result.revision,managed:true};
  }
  const saved=(await tx.query("update public.quizlab_shop_orders set status='fulfilled',contract_id=$2,fulfillment=$3::jsonb,updated_at=now() where order_id=$1 returning *",[order.order_id,contractId,JSON.stringify(fulfillment)])).rows[0];
  return dto(saved);
 }
 async function webhook(bytes,signature){
  const event=verifyTestEvent(bytes,signature,secret),object=event?.data?.object;
  if(typeof event.id!=='string'||!/^evt_[a-zA-Z0-9_-]{1,160}$/.test(event.id)||!['checkout.session.completed','invoice.paid','invoice.payment_failed'].includes(event.type)||!object)throw fail(400,'Tipo evento non supportato');
  const orderId=uuid(object.metadata?.order_id),hash=createHash('sha256').update(bytes).digest('hex');
  return db.transaction(async tx=>{
   const old=(await tx.query('select * from public.quizlab_shop_events where event_id=$1',[event.id])).rows[0];if(old){if(old.payload_hash!==hash)throw fail(409,'Evento riutilizzato con contenuto diverso');return old.result;}
   let order=(await tx.query('select * from public.quizlab_shop_orders where order_id=$1 for update',[orderId])).rows[0];if(!order||object.client_reference_id!==order.user_id||object.session_id!==order.provider_session_id)throw fail(400,'Pagamento non associato a questo ordine');
   const count=order.kind==='plan'&&order.snapshot.payment_mode==='installments'?order.snapshot.installment_count:1;
   const number=Number(object.installment_number||1);if(!Number.isInteger(number)||number<1||number>count)throw fail(400,'Rata non valida');
   const expected=Math.floor(order.snapshot.total_cents/count)+(number<=order.snapshot.total_cents%count?1:0);
   if(money(object.amount_total)!==expected||object.currency!=='eur'||event.type!=='invoice.payment_failed'&&object.payment_status!=='paid')throw fail(400,'Importo, valuta o pagamento non confermati');
   let result;
   if(event.type==='invoice.payment_failed'){
    const alreadyPaid=number===1&&['paid_pending_review','fulfilled'].includes(order.status)||order.contract_id&&
     (await tx.query("select 1 from public.quizlab_installments where contract_id=$1 and number=$2 and status='paid'",[order.contract_id,number])).rows.length>0;
    // Payment confirmation is monotonic. A late failure never erases a paid
    // receipt or blocks administrative approval of an already paid order.
    if(!alreadyPaid){
     const issue={installment:number,failed_at:new Date().toISOString(),reason:'payment_failed'};
     order=(await tx.query(`update public.quizlab_shop_orders set status=case when $2=1 and status not in ('fulfilled','paid_pending_review') then 'payment_failed' else status end,
      payment_issues=payment_issues||jsonb_build_object($2::text,$3::jsonb),updated_at=now() where order_id=$1 returning *`,[orderId,number,JSON.stringify(issue)])).rows[0];
    }
    result={ok:true,order_id:orderId,paymentFailed:true,accessRevoked:false,ignoredAlreadyPaid:!!alreadyPaid,payment_issue:dto(order).payment_issue};
   }else if(number>1){
    if(!order.contract_id)throw fail(409,'Prima rata non ancora attivata');
    await tx.query("update public.quizlab_installments set status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where contract_id=$1 and number=$2",[order.contract_id,number]);
    await tx.query("update public.quizlab_shop_orders set payment_issues=payment_issues-$2::text,updated_at=now() where order_id=$1",[orderId,number]);
    result={ok:true,order_id:orderId,installment:number,accessExtended:false};
   }else{
    order=(await tx.query("update public.quizlab_shop_orders set payment_issues=payment_issues-'1',updated_at=now() where order_id=$1 returning *",[orderId])).rows[0];
    const actor=(await tx.query('select user_id from public.quizlab_admins order by user_id limit 1')).rows[0]?.user_id;if(!actor)throw fail(503,'Amministratore non disponibile');
    result=await apply(tx,order,actor);
    if(result.reason){const row=(await tx.query("update public.quizlab_shop_orders set status='paid_pending_review',fulfillment=$2::jsonb,updated_at=now() where order_id=$1 returning *",[orderId,JSON.stringify(result)])).rows[0];result=dto(row);}
   }
   await tx.query('insert into public.quizlab_shop_events(event_id,payload_hash,order_id,event_type,result)values($1,$2,$3,$4,$5::jsonb)',[event.id,hash,orderId,event.type,JSON.stringify(result)]);return result;
  });
 }
 async function simulate(userId,input){
  await admin(userId);const order=(await db.query('select * from public.quizlab_shop_orders where order_id=$1',[uuid(input.order_id)])).rows[0];if(!order)throw fail(404,'Ordine non trovato');
  const count=order.kind==='plan'&&order.snapshot.payment_mode==='installments'?order.snapshot.installment_count:1,number=Number(input.installment_number||1);
  if(!Number.isInteger(number)||number<1||number>count)throw fail(400,'Rata non valida');
  const event={id:'evt_lab_'+randomUUID().replaceAll('-',''),livemode:false,type:input.failed?'invoice.payment_failed':number>1?'invoice.paid':'checkout.session.completed',data:{object:{session_id:order.provider_session_id,client_reference_id:order.user_id,metadata:{order_id:order.order_id},amount_total:Math.floor(order.snapshot.total_cents/count)+(number<=order.snapshot.total_cents%count?1:0),currency:'eur',payment_status:input.failed?'unpaid':'paid',installment_number:number}}};
  const bytes=Buffer.from(JSON.stringify(event));return webhook(bytes,signTestEvent(bytes,secret));
 }
 async function review(userId,input){await admin(userId);return db.transaction(async tx=>{
  const order=(await tx.query('select * from public.quizlab_shop_orders where order_id=$1 for update',[uuid(input.order_id)])).rows[0];
  if(!order||!['paid_pending_review','fulfilled'].includes(order.status))throw fail(409,'Ordine non pagato o non disponibile');
  const result=await apply(tx,order,userId,{review:true});if(result.reason)throw fail(409,'Controllo amministratore richiesto: '+result.reason);return result;
 });}
 return {catalog,createOrder,orders,library,products,saveProduct,webhook,simulate,review};
}
