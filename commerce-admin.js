import {confirmShopAction,showShopDialog} from './shop-dialog.js';
export async function mountCommerce({client}){
const cfg=globalThis.QUIZLAB_LAB_CONFIG;
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euros=n=>new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(n)/100);
const states={awaiting_payment:'In attesa pagamento',payment_failed:'Pagamento non riuscito',paid_pending_review:'Pagato · verifica richiesta',fulfilled:'Attivato'};
const reasons={approval_required:'L’account deve essere approvato e attivo',access_changed:'I permessi o la scadenza dell’account sono cambiati: verifica il nuovo riepilogo',different_plan_requires_review:'È già presente un piano diverso: verifica prima di sostituirlo',quizlab_access_required:'Serve un accesso QuizLab valido per studiare la materia',existing_course_requires_manual_assignment:'La materia esiste già: usa la gestione materie con anteprima, senza sovrascrivere i progressi',assignment_conflict:'La materia è cambiata durante l’assegnazione: aggiorna e verifica',target_exists:'La materia è già presente nel destinatario',target_missing:'La materia di destinazione non è più disponibile',revision_changed:'La materia è stata aggiornata: ricarica il riepilogo',access_not_started:'Il periodo di accesso non è ancora iniziato',course_retired:'La materia è stata ritirata dal cloud',source_not_available:'La materia sorgente non è più disponibile',payment_failed:'Pagamento di prova non riuscito'};
const reasonLabel=code=>reasons[code]||'È richiesta una verifica amministrativa';
let offset=0,rows=[],products=[],library=[],busy=false,isAdmin=false;
function message(v,bad=false){$('commerceMessage').textContent=v;$('commerceMessage').className=bad?'shop-message-error':'';}
async function api(route,body){const {data}=await client.auth.getSession();if(!data.session)throw Error('Accesso amministratore richiesto');const r=await fetch(cfg.suiteBase+'/commerce/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+data.session.access_token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),v=await r.json();if((await client.auth.getSession()).data.session?.user?.id!==data.session.user.id)throw Error('Account cambiato');if(!r.ok)throw Error(v.message||'Operazione non riuscita');return v;}
function orders(){const filter=$('commerceSearch').value.toLowerCase().trim();$('commerceOrders').innerHTML=rows.filter(o=>[o.user_id,o.user_email,o.snapshot.label,states[o.status],o.order_id].some(v=>String(v||'').toLowerCase().includes(filter))).map(o=>`<article class="shop-order"><strong>${esc(o.snapshot.label)} · ${euros(o.snapshot.total_cents)}</strong><p>${esc(states[o.status])}</p>${o.payment_issue?'<p class="shop-message-error" role="status">Pagamento da verificare · rata '+esc(o.payment_issue.installment)+' · '+esc(reasonLabel(o.payment_issue.reason))+'</p>':''}<details><summary>Account e riepilogo</summary><p>Account: ${esc(o.user_email||o.user_id)}</p><p>Ordine: ${esc(o.order_id)}</p>${o.snapshot.duration_months?'<p>Durata: '+o.snapshot.duration_months+' mesi · '+(o.snapshot.payment_mode==='installments'?o.snapshot.installment_count+' rate':'pagamento unico')+'</p>':''}${o.fulfillment?.ends_at?'<p>Scadenza: '+esc(new Date(o.fulfillment.ends_at).toLocaleString('it-IT'))+'</p>':''}${o.fulfillment?.reason?'<p>Controllo richiesto: '+esc(reasonLabel(o.fulfillment.reason))+'</p>':''}</details><div class="actions">${o.status!=='fulfilled'?'<button class="btn" data-action="paid" data-order="'+o.order_id+'">Simula pagamento riuscito</button><button class="btn secondary" data-action="failed" data-order="'+o.order_id+'">Simula pagamento fallito</button>':''}${o.status==='paid_pending_review'?'<button class="btn" data-action="review" data-order="'+o.order_id+'">Verifica e attiva ordine</button>':''}${o.status==='fulfilled'&&o.snapshot.payment_mode==='installments'&&Number(o.snapshot.installment_count)>1?'<button class="btn secondary" data-action="installment" data-order="'+o.order_id+'">Simula rata successiva</button>':''}</div></article>`).join('')||'<p>Nessun ordine corrispondente in questa pagina.</p>';}
async function refresh(){const {data}=await client.auth.getUser();const user=data.user;isAdmin=false;if(user){const {data:allowed,error}=await client.rpc('quizlab_is_admin');if(error)throw error;isAdmin=!!allowed;}$('commerceIdentity').textContent=user?(isAdmin?'Amministratore: ':'Account senza accesso amministratore: ')+user.email:'Accedi come amministratore.';$('commerceTools').hidden=!isAdmin;$('commerceLoginCard').hidden=isAdmin;$('commerceLogout').hidden=!user;if(!isAdmin){rows=[];products=[];library=[];orders();return;}[rows,products,library]=await Promise.all([api('orders?all=true&offset='+offset),api('products'),api('library')]);orders();$('commercePrevious').disabled=offset===0;$('commerceNext').disabled=rows.length<25;$('commerceProduct').innerHTML='<option value="">Nuova materia in vendita</option>'+products.map(p=>'<option value="'+esc(p.product_id)+'">'+esc(p.label)+'</option>').join('');$('productBank').innerHTML='<option value="">Scegli una tua materia</option>'+library.map(b=>'<option value="'+b.id+'">'+esc(b.subject||b.course_id)+'</option>').join('');}
$('commerceLogin').addEventListener('submit',async e=>{e.preventDefault();try{const {error}=await client.auth.signInWithPassword({email:$('commerceEmail').value,password:$('commercePassword').value});if(error)throw error;$('commercePassword').value='';await refresh();}catch(e){message(e.message,true);}});
$('commerceLogout').addEventListener('click',async()=>{await client.auth.signOut({scope:'local'});await refresh();});$('commerceReload').addEventListener('click',async()=>{try{await refresh();message('Dati aggiornati.');}catch(e){message(e.message,true);}});$('commerceSearch').addEventListener('input',orders);
$('commercePrevious').addEventListener('click',async()=>{offset=Math.max(0,offset-25);await refresh().catch(e=>message(e.message,true));});$('commerceNext').addEventListener('click',async()=>{offset+=25;await refresh().catch(e=>message(e.message,true));});
$('commerceProduct').addEventListener('change',()=>{const p=products.find(p=>p.product_id===$('commerceProduct').value);$('productId').value=p?.product_id||'';$('productId').readOnly=!!p;$('productLabel').value=p?.label||'';$('productPrice').value=p?(Number(p.total_cents)/100).toFixed(2).replace('.',','):'';$('productBank').value=p?.source_bank_id||'';$('productActive').checked=p?.active||false;});
$('productForm').addEventListener('submit',async e=>{
 e.preventDefault();if(busy||!isAdmin)return;busy=true;
 try{
  const raw=$('productPrice').value.trim().replace(',','.');if(!/^\d{1,8}(\.\d{1,2})?$/.test(raw))throw Error('Inserisci un prezzo in euro con massimo due decimali');
  const p=products.find(p=>p.product_id===$('commerceProduct').value),body={product_id:$('productId').value.trim(),label:$('productLabel').value.trim(),source_bank_id:$('productBank').value,total_cents:Math.round(Number(raw)*100),active:$('productActive').checked,expected_version:p?.version||0};
  const source=library.find(item=>item.id===body.source_bank_id);
  if(!await confirmShopAction({title:'Salva materia nella vetrina di prova',lines:[body.label,'Prezzo totale: '+euros(body.total_cents),'Fonte: '+(source?.subject||source?.course_id||'Da verificare'),body.active?'La materia sarà visibile nella vetrina di prova online.':'La materia resterà nascosta nella vetrina di prova.','La materia sarà visibile agli utenti. Nessun addebito reale.'],confirmLabel:'Conferma salvataggio'}))return;
  await api('products',body);await refresh();message('Materia in vendita salvata nel sistema.');
 }catch(e){message(e.message,true);}finally{busy=false;}
});
$('commerceOrders').addEventListener('click',async e=>{
 const b=e.target.closest('[data-action]');if(!b||busy||!isAdmin)return;busy=true;
 try{
  const o=rows.find(o=>o.order_id===b.dataset.order);if(!o)return;
  let body={order_id:o.order_id},route='simulate';
  const lines=[o.snapshot.label,'Account: '+(o.user_email||o.user_id),'Totale ordine: '+euros(o.snapshot.total_cents)];
  if(b.dataset.action==='review'){
   route='review';
   if(!await confirmShopAction({title:'Verifica e attiva ordine',lines:[...lines,...(o.snapshot.duration_months?['Durata: '+o.snapshot.duration_months+' mesi']:[]),'Verifica prima approvazione, strumenti e piano dell’account.','Pagamento già confermato in prova. Nessun addebito reale.'],confirmLabel:'Conferma attivazione'}))return;
  }else if(b.dataset.action==='installment'){
   const count=Number(o.snapshot.installment_count);if(count<2)throw Error('Questo ordine non prevede rate successive.');
   const result=await showShopDialog({title:'Simula rata successiva',lines:[...lines,'Seleziona la rata da segnare pagata in prova. Il pagamento non aggiunge mesi di accesso.','Nessun addebito reale.'],number:{label:'Numero rata (da 2 a '+count+')',min:2,max:count,value:2,describe:n=>'Importo della rata '+n+': '+euros(Math.floor(Number(o.snapshot.total_cents)/count)+(n<=Number(o.snapshot.total_cents)%count?1:0))},confirmLabel:'Conferma pagamento di prova'});
   if(!result.confirmed)return;body.installment_number=result.value;
  }else{
   if(!['paid','failed'].includes(b.dataset.action))throw Error('Operazione non disponibile.');
   body.failed=b.dataset.action==='failed';
   if(!await confirmShopAction({title:body.failed?'Simula pagamento fallito':'Simula pagamento riuscito',lines:[...lines,body.failed?'Registra un pagamento di prova non riuscito.':'Registra il pagamento riuscito in prova.','Nessun addebito reale.'],confirmLabel:'Conferma simulazione'}))return;
  }
  b.disabled=true;await api(route,body);await refresh();message('Operazione di prova registrata.');
 }catch(e){message(e.message,true);}finally{busy=false;b.disabled=false;}
});
await refresh().catch(e=>message(e.message,true));
return {refresh};

}
