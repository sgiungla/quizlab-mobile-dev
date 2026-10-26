const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createRecipientPicker(host,{users,onChange}){
 let selected=new Set(),search='',page=0;const size=20;
 function render(){
  const all=users(),rows=all.filter(u=>String(u.email||'').toLowerCase().includes(search.toLowerCase())),pages=Math.max(1,Math.ceil(rows.length/size));page=Math.min(page,pages-1);
  host.innerHTML='<label>Cerca destinatari<input type="search" data-recipient-search value="'+esc(search)+'" placeholder="Email dell’account"></label><p role="status">'+selected.size+' selezionati · '+rows.length+' corrispondenze · pagina '+(page+1)+' di '+pages+'</p><div class="study-grid">'+rows.slice(page*size,(page+1)*size).map(u=>'<label><input type="checkbox" data-recipient value="'+esc(u.id)+'" '+(selected.has(u.id)?'checked':'')+'>'+esc(u.email)+'</label>').join('')+'</div><div class="actions"><button type="button" class="btn secondary" data-recipient-page="-1" '+(page===0?'disabled':'')+'>Precedenti</button><button type="button" class="btn secondary" data-recipient-page="1" '+(page>=pages-1?'disabled':'')+'>Successivi</button><button type="button" class="btn secondary" data-recipient-clear>Azzera selezione</button></div>';
 }
 host.addEventListener('input',e=>{if(e.target.matches('[data-recipient-search]')){search=e.target.value;page=0;const start=e.target.selectionStart;render();const input=host.querySelector('[data-recipient-search]');input.focus();input.setSelectionRange?.(start,start);}});
 host.addEventListener('change',e=>{if(e.target.matches('[data-recipient]')){if(e.target.checked)selected.add(e.target.value);else selected.delete(e.target.value);render();onChange();}});
 host.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.recipientPage){page=Math.max(0,page+Number(b.dataset.recipientPage));render();}else if(b.hasAttribute('data-recipient-clear')){selected.clear();render();onChange();}});
 return{render,selected:()=>[...selected],clear:()=>{selected.clear();render();},set:ids=>{selected=new Set(ids);render();}};
}
