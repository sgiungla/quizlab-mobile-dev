import {CAMPAIGN_FIELDS,campaignVariables} from './campaign-template-fields.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const controls=[
 {key:'courseId',label:'Materia per le variabili',list:'courses',variables:['nome_materia','domande_rimanenti','domande_da_ripassare','percentuale_completamento'],automatic:'Tutte le materie / materia del riferimento; per il nome deve essere unica'},
 {key:'goalId',label:'Obiettivo',list:'goals',variables:['obiettivo','giorni_obiettivo'],automatic:'Automatico solo con un obiettivo compatibile'},
 {key:'examId',label:'Esame',list:'exams',variables:['giorni_esame'],automatic:'Automatico solo con un esame futuro compatibile'},
 {key:'badgeKey',label:'Traguardo già ottenuto',list:'badges',variables:['traguardo'],automatic:'Automatico solo con un traguardo assegnato'}
];
export function renderCampaignReferences({users,selectedUserIds=[],title='',message='',references={}}){
 const used=campaignVariables(title,message),needed=controls.filter(c=>c.variables.some(v=>used.includes(v)));
 if(!needed.length)return'<p class="subtle">Questo messaggio non richiede riferimenti a materie, obiettivi, esami o traguardi.</p>';
 const targets=users.filter(u=>!selectedUserIds.length||selectedUserIds.includes(u.id));
 if(!targets.length)return'<p class="subtle">Nessun destinatario disponibile. Accedi e aggiorna i dati del pannello.</p>';
 return targets.map(u=>`<details class="study-card"><summary>${esc(u.email)}</summary><div class="grid">${needed.map(c=>{
  const value=references[u.id]?.[c.key]||'',list=u[c.list]||[],present=list.some(i=>i.id===value);
  return`<label>${esc(c.label)}<select data-reference-user="${esc(u.id)}" data-reference-kind="${c.key}"><option value="">${esc(c.automatic)}</option>${value&&!present?`<option selected value="${esc(value)}">Riferimento salvato non più disponibile: scegli un altro</option>`:''}${list.map(i=>`<option value="${esc(i.id)}" ${i.id===value?'selected':''}>${esc(i.label)}${i.paused?' · sospeso':''}${i.cancelled?' · annullato':''}${c.key==='goalId'?i.deadline?' · scadenza '+esc(i.deadline):' · senza scadenza':''}</option>`).join('')}</select></label>`;
 }).join('')}</div></details>`).join('');
}
export function readCampaignReferences(container){
 const result={};for(const el of container.querySelectorAll('[data-reference-user]'))if(el.value){const user=el.dataset.referenceUser,key=el.dataset.referenceKind;(result[user]??={})[key]=el.value;}return result;
}
export function renderCampaignVariableHelp(){return CAMPAIGN_FIELDS.map(f=>`<details><summary><code>{${f.key}}</code> · ${esc(f.label)}</summary><p>${esc(f.requirement)}</p></details>`).join('');}
const buttonLabels={nome_utente:'Nome utente',nome_materia:'Materia',domande_rimanenti:'Domande rimanenti',domande_da_ripassare:'Domande da ripassare',percentuale_completamento:'Copertura %',giorni_esame:'Giorni all’esame',giorni_obiettivo:'Giorni all’obiettivo',giorni_inattivita:'Giorni di inattività',obiettivo:'Obiettivo',traguardo:'Traguardo'};
export function renderCampaignVariableButtons(){
 return CAMPAIGN_FIELDS.map(f=>`<button type="button" class="btn secondary" data-insert-variable="${f.key}" title="{${f.key}} · ${esc(f.requirement)}">${esc(buttonLabels[f.key]||f.label)}</button>`).join('');
}
export const CAMPAIGN_EMOJIS=Object.freeze([
 {emoji:'🎯',label:'Obiettivo'},{emoji:'📚',label:'Studio'},{emoji:'🧠',label:'Memoria'},{emoji:'📝',label:'Esercitazione'},
 {emoji:'📖',label:'Lettura'},{emoji:'🔁',label:'Ripasso'},{emoji:'📅',label:'Esame'},{emoji:'⏳',label:'Countdown'},
 {emoji:'🔔',label:'Promemoria'},{emoji:'✅',label:'Completato'},{emoji:'🏆',label:'Traguardo'},{emoji:'🌟',label:'Risultato'},
 {emoji:'💪',label:'Motivazione'},{emoji:'👏',label:'Congratulazioni'},{emoji:'🎉',label:'Festeggiamento'},{emoji:'🚀',label:'Progresso'}
].map(Object.freeze));
export function renderCampaignEmojiButtons(){
 return CAMPAIGN_EMOJIS.map(e=>`<button type="button" class="btn secondary campaign-emoji" data-insert-emoji="${e.emoji}" title="${esc(e.label)}" aria-label="Inserisci emoji: ${esc(e.label)}"><span aria-hidden="true">${e.emoji}</span></button>`).join('');
}
export function createCampaignVariableEditor({title,message,buttons,status,emojiToggle=null,emojis=null,onError=()=>{}}){
 let target=message;
 const showTarget=()=>{status.textContent=target===title?'Inserimento nel titolo':'Inserimento nel messaggio';};
 const showEmojis=open=>{if(!emojiToggle||!emojis)return;emojis.hidden=!open;emojiToggle.setAttribute('aria-expanded',String(open));emojiToggle.textContent=open?'Chiudi emoji':'😊 Inserisci emoji';};
 for(const field of [title,message])field.addEventListener('focus',()=>{target=field;showTarget();});
 buttons.innerHTML=renderCampaignVariableButtons();
 function insertText(token,label){
  const value=target.value;
  const start=target.selectionStart??value.length,end=target.selectionEnd??start;
  const next=value.slice(0,start)+token+value.slice(end);
  if(target.maxLength>=0&&next.length>target.maxLength){
   onError(`${label} supera il limite di ${target.maxLength} caratteri del ${target===title?'titolo':'messaggio'}. Accorcia il testo e riprova.`,true);
   return false;
  }
  target.value=next;target.focus();target.setSelectionRange(start+token.length,start+token.length);
  // Use the same edit path as typing: references refresh and any preview expires.
  const InputEvent=target.ownerDocument.defaultView.Event;
  target.dispatchEvent(new InputEvent('input',{bubbles:true}));
  return true;
 }
 function insert(key){return CAMPAIGN_FIELDS.some(f=>f.key===key)?insertText('{'+key+'}','La variabile'):false;}
 function insertEmoji(emoji){
  if(!CAMPAIGN_EMOJIS.some(e=>e.emoji===emoji)||!insertText(emoji,'L’emoji'))return false;
  showEmojis(false);return true;
 }
 buttons.addEventListener('click',event=>{
  const button=event.target.closest('[data-insert-variable]');
  if(button&&buttons.contains(button))insert(button.dataset.insertVariable);
 });
 if(emojiToggle&&emojis){
  emojis.innerHTML=renderCampaignEmojiButtons();showEmojis(false);
  emojiToggle.addEventListener('click',()=>showEmojis(emojis.hidden));
  emojis.addEventListener('click',event=>{
   const button=event.target.closest('[data-insert-emoji]');
   if(button&&emojis.contains(button))insertEmoji(button.dataset.insertEmoji);
  });
  emojis.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();showEmojis(false);emojiToggle.focus();}});
 }
 showTarget();
 return{insert,insertEmoji,reset(){target=message;showTarget();showEmojis(false);}};
}
export function renderCampaignPreview(preview){
 const accepted=preview.recipients||[],excluded=preview.excluded||[];
 return`<strong>${Number(preview.count)} destinatari idonei di prova · ${excluded.length} esclusi</strong>${accepted.map((u,index)=>`<details class="study-card" ${index===0?'open':''}><summary>Anteprima per ${esc(u.email)}</summary><h3>${esc(u.title)}</h3><p style="white-space:pre-wrap">${esc(u.message)}</p>${Object.keys(u.values||{}).length?`<details><summary>Valori utilizzati</summary>${Object.entries(u.values).map(([key,value])=>`<p><code>{${esc(key)}}</code>: ${esc(value)}</p>`).join('')}</details>`:''}</details>`).join('')}${excluded.length?`<h3>Destinatari esclusi e motivi</h3>${excluded.map(u=>`<details class="study-card" open><summary>${esc(u.email)}</summary><ul>${u.issues.map(i=>`<li>${(i.variables||[]).map(k=>`<code>{${esc(k)}}</code>`).join(', ')}${i.variables?.length?': ':''}${esc(i.message)}</li>`).join('')}</ul></details>`).join('')}`:''}${!accepted.length?'<p class="study-error">Nessun messaggio sarà inviato. Risolvi i motivi indicati e ripeti l’anteprima.</p>':''}`;
}
