const PAGE_SIZE=25;
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const integer=value=>Math.max(0,Math.floor(Number(value)||0));
const defaults=()=>({search:'',approval:'all',status:'all',plan:'all',expiry:'all',activity:'all',sort:'email',direction:'asc'});
const enums={approval:['all','pending','active','suspended'],status:['all','pending','active','suspended','expired'],expiry:['all','none','expired','7d','30d'],activity:['all','never','7d','30d','inactive30d'],sort:['email','status','expires_at','last_seen','course_count','created_at'],direction:['asc','desc']};
export function createAdminUserListState(){return{filters:defaults(),page:1,data:{page:1,page_size:PAGE_SIZE,total:0,total_pages:0,summary:{},items:[]},expanded:new Set(),details:new Map(),loading:false,error:''};}
export function updateAdminUserFilters(state,value={}){
 const next=defaults();
 next.search=String(value.search||'').trim().slice(0,200);
 next.plan=String(value.plan||'all').trim().slice(0,128)||'all';
 for(const key of Object.keys(enums))if(enums[key].includes(value[key]))next[key]=value[key];
 state.filters=next;state.page=1;state.expanded.clear();state.details.clear();return next;
}
export function resetAdminUserFilters(state){return updateAdminUserFilters(state,defaults());}
export function adminUserPageRequest(state){
 const f=state.filters;
 return{search_text:f.search,approval_filter:f.approval,status_filter:f.status,plan_filter:f.plan,expiry_filter:f.expiry,activity_filter:f.activity,sort_by:f.sort,sort_dir:f.direction,page_number:Math.max(1,integer(state.page)),page_size:PAGE_SIZE};
}
export function applyAdminUserPage(state,value={}){
 const items=Array.isArray(value.items)?value.items.slice(0,PAGE_SIZE):[];
 const total=integer(value.total),page=Math.max(1,integer(value.page)||state.page),totalPages=Math.ceil(total/PAGE_SIZE);
 state.page=page;state.data={...value,page,page_size:PAGE_SIZE,total,total_pages:totalPages,summary:value.summary||{},items};
 const visible=new Set(items.map(user=>user.user_id));
 for(const id of state.expanded)if(!visible.has(id))state.expanded.delete(id);
 for(const id of state.details.keys())if(!visible.has(id))state.details.delete(id);
 state.loading=false;state.error='';return state.data;
}
export function readAdminUserFilters(document,prefix='adminUsers'){
 const values={};for(const key of Object.keys(defaults()))values[key]=document.getElementById(prefix+'-'+key)?.value;
 return values;
}
const dateLabel=value=>{if(!value)return'—';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric'}):'—';};
const activityLabel=value=>{if(!value)return'Mai';const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('it-IT',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';};
const decimal=value=>value==null?'—':escapeHtml(String(value).replace('.',','));
export function adminEffectiveStatus(user){return user.status||user.account_status||user.approval_status||'pending';}
export function renderAdminUserDetails(user,detail={}){
 const stats=Array.isArray(detail.stats)?detail.stats:[],attempts=stats.reduce((n,row)=>n+integer(row.attempt_count),0),unique=stats.reduce((n,row)=>n+integer(row.unique_question_count),0),correct=stats.reduce((n,row)=>n+integer(row.correct_count),0);
 const accuracy=unique?Math.round(correct/unique*1000)/10:null;
 const rows=stats.map(row=>'<div class="admin-course"><strong>'+escapeHtml(row.subject||row.course_id)+'</strong><div class="result-meta">'+integer(row.attempt_count)+' tentativi · '+integer(row.unique_question_count)+' domande uniche · rendimento viste '+decimal(row.accuracy_pct)+(row.accuracy_pct==null?'':'%')+'</div><div class="result-meta">'+integer(row.exam_count)+' esami · media '+decimal(row.avg_exam_grade)+(row.avg_exam_grade==null?'':'/30')+' · migliore '+decimal(row.best_exam_grade)+(row.best_exam_grade==null?'':'/30')+'</div><div class="result-meta">Materia completa '+integer(row.full_seen_count)+' · da recuperare '+integer(row.pending_review_count)+' · segnate '+integer(row.marked_count)+'</div></div>').join('');
 return'<div class="admin-user-detail-summary">'+attempts+' tentativi · '+unique+' domande uniche'+(accuracy==null?'':' · rendimento viste '+decimal(accuracy)+'%')+'</div><div class="result-meta">Ultimo accesso: '+escapeHtml(activityLabel(user.last_sign_in_at))+'</div><div class="admin-course-list">'+(rows||'<p class="subtle">Nessuna statistica di studio registrata.</p>')+'</div>';
}
function selectField(prefix,key,label,choices,value){return'<label class="admin-user-filter"><span>'+label+'</span><select id="'+escapeHtml(prefix+'-'+key)+'">'+choices.map(([id,text])=>'<option value="'+escapeHtml(id)+'"'+(String(value)===String(id)?' selected':'')+'>'+escapeHtml(text)+'</option>').join('')+'</select></label>';}
export function renderAdminUserList(state,{selfId=null,prefix='adminUsers',plans=[],actionsHtml=()=>'',detailHtml=renderAdminUserDetails}={}){
 const f=state.filters,data=state.data,items=data.items||[],total=integer(data.total),pages=Math.max(1,integer(data.total_pages));
 const planOptions=[['all','Tutti i piani'],['none','Senza piano']],seen=new Set(['all','none']);
 for(const plan of plans||[]){const id=plan.id||plan.plan_id;if(id&&!seen.has(id)){seen.add(id);planOptions.push([id,plan.label||plan.name||id]);}}
 if(!seen.has(f.plan))planOptions.push([f.plan,'Piano selezionato']);
 const filters='<div class="admin-user-filters" id="'+escapeHtml(prefix+'-filters')+'"><label class="admin-user-filter admin-user-search"><span>Cerca email o ID</span><input type="search" id="'+escapeHtml(prefix+'-search')+'" value="'+escapeHtml(f.search)+'" maxlength="200" placeholder="Email o identificativo" autocomplete="off"></label>'+
 selectField(prefix,'approval','Approvazione',[['all','Tutte'],['pending','In attesa'],['active','Approvati'],['suspended','Sospesi / rifiutati']],f.approval)+
 selectField(prefix,'status','Accesso effettivo',[['all','Tutti'],['active','Attivi'],['pending','In attesa'],['suspended','Sospesi'],['expired','Scaduti']],f.status)+
 selectField(prefix,'plan','Piano',planOptions,f.plan)+
 selectField(prefix,'expiry','Scadenza',[['all','Tutte'],['none','Senza scadenza'],['expired','Già scaduti'],['7d','Entro 7 giorni'],['30d','Entro 30 giorni']],f.expiry)+
 selectField(prefix,'activity','Ultima attività',[['all','Qualsiasi'],['never','Mai'],['7d','Ultimi 7 giorni'],['30d','Ultimi 30 giorni'],['inactive30d','Inattivi da oltre 30 giorni']],f.activity)+
 selectField(prefix,'sort','Ordina per',[['email','Email'],['status','Accesso'],['expires_at','Scadenza'],['last_seen','Ultima attività'],['course_count','Numero materie'],['created_at','Registrazione']],f.sort)+
 selectField(prefix,'direction','Ordine',[['asc','Crescente'],['desc','Decrescente']],f.direction)+'<div class="actions admin-user-filter-actions"><button class="btn compact-btn" data-action="admin-users-filter"'+(state.loading?' disabled':'')+'>Applica filtri</button><button class="btn ghost compact-btn" data-action="admin-users-reset"'+(state.loading?' disabled':'')+'>Azzera filtri</button></div></div>';
 const countLabel=state.loading?'Caricamento elenco utenti…':state.error?'Elenco non disponibile':total?'Utenti '+((state.page-1)*PAGE_SIZE+1)+'–'+Math.min(state.page*PAGE_SIZE,total)+' di '+total:'Nessun utente corrisponde ai filtri';
 const pager='<div class="admin-user-pagination"><span>'+escapeHtml(countLabel)+' · 25 per pagina</span><div class="actions"><button class="btn ghost compact-btn" data-action="admin-users-previous"'+(state.loading||state.error||state.page<=1?' disabled':'')+' aria-label="Pagina utenti precedente">← Precedente</button><span>Pagina '+state.page+' di '+pages+'</span><button class="btn ghost compact-btn" data-action="admin-users-next"'+(state.loading||state.error||state.page>=pages?' disabled':'')+' aria-label="Pagina utenti successiva">Successiva →</button></div></div>';
 const rows=items.map(user=>{
  const id=user.user_id,status=adminEffectiveStatus(user),label=({active:'Attivo',pending:'In attesa',suspended:'Sospeso',expired:'Scaduto'})[status]||'Da verificare',open=state.expanded.has(id),entry=state.details.get(id),approval=user.approval_status||user.account_status||'pending';
  const approvalLabel=approval==='active'?'Approvato':approval==='suspended'?'Sospeso / rifiutato':'Da approvare';
  const detailId=prefix+'-detail-'+id;
  const details=open?'<div class="admin-user-expanded" id="'+escapeHtml(detailId)+'">'+(entry?.loading?'<p class="subtle" role="status">Caricamento dettagli…</p>':entry?.error?'<p class="admin-user-error" role="alert">'+escapeHtml(entry.error)+'</p><button class="btn ghost compact-btn" data-action="admin-users-detail-retry" data-user="'+escapeHtml(id)+'">Riprova dettagli</button>':entry?.data?detailHtml(user,entry.data):'<p class="subtle" role="status">Dettagli non ancora caricati.</p>')+'</div>':'';
  return'<article class="admin-user-card" data-admin-user="'+escapeHtml(id)+'"><div class="admin-user-compact"><div class="admin-user-identity"><strong>'+escapeHtml(user.email||id)+'</strong><small>'+escapeHtml(id)+'</small><div class="pill-row"><span class="pill '+(status==='active'?'ok-pill':status==='pending'||status==='expired'?'warn-pill':'')+'">'+label+'</span><span class="pill">'+approvalLabel+'</span>'+(user.is_admin||id===selfId?'<span class="pill">Amministratore</span>':'')+'</div></div><div class="admin-user-facts"><span><b>Piano</b>'+escapeHtml(user.plan?.label||'Senza piano')+'</span><span><b>Scadenza</b>'+escapeHtml(user.expires_at?dateLabel(user.expires_at):'Nessuna')+'</span><span><b>Ultima attività</b>'+escapeHtml(activityLabel(user.last_activity||user.last_seen||user.last_sign_in_at))+'</span><span><b>Studio</b>'+integer(user.course_count)+' materie · '+integer(user.attempt_count)+' tentativi · '+integer(user.exam_count)+' esami</span></div><div class="actions admin-user-row-actions">'+actionsHtml(user)+'<button class="btn secondary compact-btn" data-action="admin-users-detail" data-user="'+escapeHtml(id)+'" aria-expanded="'+open+'" aria-controls="'+escapeHtml(detailId)+'">'+(open?'Chiudi dettagli':'Accessi e statistiche')+'</button></div></div>'+details+'</article>';
 }).join('');
 return'<div class="admin-user-dashboard" aria-busy="'+!!state.loading+'">'+filters+(state.error?'<p class="admin-user-error" role="alert">'+escapeHtml(state.error)+'</p>':'')+pager+'<div class="admin-list">'+(state.loading?'<p class="subtle" role="status">Caricamento utenti…</p>':state.error?'<div class="empty">Riprova con “Applica filtri” o “Aggiorna”.</div>':rows||'<div class="empty">Nessun utente corrisponde ai filtri.</div>')+'</div>'+pager+'</div>';
}
