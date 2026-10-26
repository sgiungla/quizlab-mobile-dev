import {confirmShopAction} from './shop-dialog.js';
const cfg=globalThis.QUIZLAB_LAB_CONFIG;
if(cfg?.mode!=='production')throw Error('Configurazione non valida');
const client=globalThis.supabase.createClient(cfg.apiBase,cfg.publishableKey),$=id=>document.getElementById(id);
const names={lessons:'Lezioni',kit_ai:'Kit AI',question_banks:'Panieri',handouts:'Dispense',quizlab_desktop:'QuizLab desktop',quizlab_pwa:'QuizLab web app'};
const status={awaiting_payment:'In attesa del pagamento di prova',payment_failed:'Pagamento di prova non riuscito',paid_pending_review:'Pagato in prova · verifica amministratore richiesta',fulfilled:'Attivato'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const euros=n=>new Intl.NumberFormat('it-IT',{style:'currency',currency:'EUR'}).format(Number(n)/100);
let user=null,offset=0,offers={plans:[],products:[]},busy=false;
async function api(route,{body,publicRead=false}={}){
 const {data}=await client.auth.getSession(),token=data.session?.access_token;
 if(!publicRead&&!token)throw Error('Accedi prima con il tuo account');
 const r=await fetch(cfg.suiteBase+'/commerce/'+route,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}),value=await r.json();
 if(!r.ok)throw Error(value.message||'Operazione non disponibile');return value;
}
function message(text,error=false){$('shopMessage').textContent=text;$('shopMessage').className=error?'shop-message-error':'';}
function draw(){
 $('shopPlans').innerHTML=offers.plans.map(p=>`<article class="card"><h3>${esc(p.label)}</h3><p>${p.duration_months} ${Number(p.duration_months)===1?'mese':'mesi'} di accesso</p><div class="shop-price">${euros(p.total_cents)}</div><p>${p.payment_mode==='installments'?`${p.installment_count} rate · totale ${euros(p.total_cents)}`:'Pagamento unico'}</p><ul class="shop-modules">${Object.entries(p.modules).filter(([,yes])=>yes).map(([key])=>'<li>'+esc(names[key])+'</li>').join('')}</ul><button class="btn" data-buy="plan" data-item="${esc(p.plan_id)}">Scegli in prova</button></article>`).join('')||'<p>Nessun piano disponibile.</p>';
 $('shopProducts').innerHTML=offers.products.map(p=>`<article class="card"><h3>${esc(p.label)}</h3><div class="shop-price">${euros(p.total_cents)}</div><p>Materia gestita dall’amministratore. Non include Kit AI o rinnovo della licenza QuizLab.</p><button class="btn" data-buy="course" data-item="${esc(p.product_id)}">Scegli in prova</button></article>`).join('')||'<p>Le materie in vendita saranno configurate dall’amministratore.</p>';
}
async function refreshOrders(){
 $('shopOrders').innerHTML='';$('shopPrevious').disabled=offset===0;
 if(!user){$('shopNext').disabled=true;return;}
 const rows=await api('orders?offset='+offset);$('shopNext').disabled=rows.length<25;
 $('shopOrders').innerHTML=rows.map(o=>`<article class="shop-order"><strong>${esc(o.snapshot.label)}</strong><p>${esc(status[o.status]||o.status)} · ${euros(o.snapshot.total_cents)}</p>${o.fulfillment?.ends_at?'<p>Accesso fino al '+esc(new Date(o.fulfillment.ends_at).toLocaleString('it-IT'))+'</p>':''}<details><summary>Dettagli ordine</summary><p>${esc(o.order_id)}</p></details></article>`).join('')||'<p>Nessun ordine in questa pagina.</p>';
}
async function identity(){const {data}=await client.auth.getUser();user=data.user||null;$('shopIdentity').textContent=user?'Account: '+user.email:'Accedi con un account destinatario del laboratorio.';$('shopLogin').hidden=!!user;$('shopLogout').hidden=!user;await refreshOrders();}
$('shopLogin').addEventListener('submit',async e=>{e.preventDefault();try{const {error}=await client.auth.signInWithPassword({email:$('shopEmail').value,password:$('shopPassword').value});if(error)throw error;$('shopPassword').value='';offset=0;await identity();message('Accesso riuscito.');}catch(e){message(e.message,true);}});
$('shopLogout').addEventListener('click',async()=>{await client.auth.signOut({scope:'local'});user=null;offset=0;await identity();});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-buy]');if(!b||busy)return;busy=true;try{
 if(!user){message('Accedi prima. La scelta non effettua addebiti.');$('shopAccount').scrollIntoView({behavior:'smooth'});return;}
 const p=(b.dataset.buy==='plan'?offers.plans:offers.products).find(p=>(p.plan_id||p.product_id)===b.dataset.item);
 if(!p)throw Error('Offerta non disponibile: aggiorna la vetrina.');
 const lines=[p.label,'Totale: '+euros(p.total_cents),b.dataset.buy==='plan'?p.duration_months+' '+(Number(p.duration_months)===1?'mese':'mesi')+' · '+(p.payment_mode==='installments'?p.installment_count+' rate':'pagamento unico'):'Serve una licenza QuizLab valida. La materia non la rinnova.',...(b.dataset.buy==='plan'?['Strumenti: '+Object.entries(p.modules).filter(([,yes])=>yes).map(([key])=>names[key]).join(', ')]:[]),'Crea questo ordine di prova? Nessun addebito reale.'];
 if(!await confirmShopAction({title:'Riepilogo ordine di prova',lines,confirmLabel:'Conferma ordine di prova'}))return;b.disabled=true;
 await api('checkout',{body:{kind:b.dataset.buy,item_id:b.dataset.item,expected_version:p.version,request_id:crypto.randomUUID()}});offset=0;await refreshOrders();message('Ordine di prova creato. L’amministratore può simulare il pagamento dalla gestione acquisti.');$('shopAccount').scrollIntoView({behavior:'smooth'});
 }catch(e){message(e.message,true);}finally{busy=false;b.disabled=false;}});
$('shopPrevious').addEventListener('click',async()=>{offset=Math.max(0,offset-25);try{await refreshOrders();}catch(e){message(e.message,true);}});$('shopNext').addEventListener('click',async()=>{offset+=25;try{await refreshOrders();}catch(e){message(e.message,true);}});
try{offers=await api('catalog',{publicRead:true});draw();await identity();}catch(e){message(e.message,true);}
