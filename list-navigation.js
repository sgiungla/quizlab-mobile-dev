(function(root){
 'use strict';
 const states=new Map(),escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fold=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('it');
 function mount(host,{key,rows,renderItem,text=()=>'',label='elementi',pageSize=12,empty='Nessun elemento disponibile.',searchable=true}){
  if(!host)return;
  if(!Number.isInteger(pageSize)||pageSize<1)throw Error('Dimensione pagina non valida');
  if(!states.has(key)){if(states.size>=100)states.delete(states.keys().next().value);states.set(key,{page:0,query:''});}
  const state=states.get(key),doc=host.ownerDocument,showSearch=searchable&&(rows.length>pageSize||!!state.query);
  host.classList.add('ql-list-navigation');
  const originalClass=host.dataset.listItemsClass||host.className.replace('ql-list-navigation','').trim();host.dataset.listItemsClass=originalClass;
  host.className='ql-list-navigation';
  host.innerHTML=(showSearch?'<label class="ql-list-search">Cerca '+escape(label)+'<input type="search" maxlength="200" aria-label="Cerca '+escape(label)+'" placeholder="Cerca per nome"></label>':'')+'<div data-list-info class="study-muted" role="status" aria-live="polite"></div><div data-list-items></div><nav data-list-controls class="study-row ql-list-controls" aria-label="Pagine '+escape(label)+'"><button type="button" class="ql-btn ghost compact btn secondary" data-list-back>← Precedenti</button><span data-list-page></span><button type="button" class="ql-btn ghost compact btn secondary" data-list-next>Successive →</button></nav>';
  const items=host.querySelector('[data-list-items]');items.className=originalClass;
  const input=host.querySelector('input'),info=host.querySelector('[data-list-info]'),controls=host.querySelector('[data-list-controls]'),back=host.querySelector('[data-list-back]'),next=host.querySelector('[data-list-next]');
  function draw(){
   const query=fold(state.query).trim(),filtered=query?rows.filter(row=>fold(text(row)).includes(query)):rows,total=filtered.length,pages=Math.max(1,Math.ceil(total/pageSize));state.page=Math.min(state.page,pages-1);
   const start=state.page*pageSize;items.innerHTML=filtered.slice(start,start+pageSize).map(renderItem).join('')||'<p class="study-muted">'+escape(query?'Nessun risultato per questa ricerca.':empty)+'</p>';
   info.hidden=!showSearch&&rows.length<=pageSize;info.textContent=total?(start+1)+'–'+Math.min(start+pageSize,total)+' di '+total+' '+label:'0 '+label;
   controls.hidden=pages<=1;host.querySelector('[data-list-page]').textContent='Pagina '+(state.page+1)+' di '+pages;back.disabled=state.page===0;next.disabled=state.page>=pages-1;
  }
  if(input){input.value=state.query;input.addEventListener('input',e=>{e.stopPropagation();state.query=input.value;state.page=0;draw();});}
  for(const [button,delta]of [[back,-1],[next,1]])button.addEventListener('click',e=>{e.stopPropagation();state.page+=delta;draw();host.scrollIntoView?.({block:'nearest'});button.disabled?controls.querySelector('button:not(:disabled)')?.focus():button.focus();});
  draw();return{page:()=>state.page,query:()=>state.query};
 }
 root.QuizLabListNavigation={mount};
})(globalThis);
