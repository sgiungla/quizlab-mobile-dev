let activeDialog = null;
let serial = 0;

// DOM-only confirmations: never fall back to blocking native browser dialogs.
// Values are textContent, so offer/account names cannot become HTML markup.
export function showShopDialog({title,lines=[],confirmLabel='Conferma',number=null}) {
 if(activeDialog)return Promise.resolve({confirmed:false,value:null});
 if(number&&(!Number.isInteger(number.min)||!Number.isInteger(number.max)||number.min>number.max))return Promise.reject(Error('Intervallo della rata non valido'));
 return new Promise((resolve,reject)=>{
  const previousFocus=document.activeElement,id='shop-dialog-'+(++serial),dialog=document.createElement('dialog');
  dialog.className='shop-dialog';dialog.setAttribute('aria-labelledby',id+'-title');dialog.setAttribute('aria-describedby',id+'-description');
  const form=document.createElement('form');form.noValidate=true;
  const header=document.createElement('div');header.className='shop-dialog-header';
  const heading=document.createElement('h2');heading.id=id+'-title';heading.textContent=String(title||'Conferma operazione');
  const closeButton=document.createElement('button');closeButton.type='button';closeButton.className='btn ghost shop-dialog-close';closeButton.setAttribute('aria-label','Chiudi riepilogo');closeButton.textContent='×';
  header.append(heading,closeButton);form.append(header);
  const description=document.createElement('div');description.id=id+'-description';description.className='shop-dialog-description';
  for(const line of lines){const paragraph=document.createElement('p');paragraph.textContent=String(line);description.append(paragraph);}
  form.append(description);
  let input=null,numberSummary=null;
  if(number){
   const label=document.createElement('label');label.htmlFor=id+'-number';label.textContent=number.label||'Numero rata';
   input=document.createElement('input');input.id=id+'-number';input.type='number';input.inputMode='numeric';input.min=String(number.min);input.max=String(number.max);input.step='1';input.required=true;
   input.value=String(number.value??number.min);input.setAttribute('aria-describedby',id+'-error'+(number.describe?' '+id+'-number-summary':''));
   form.append(label,input);
   if(number.describe){numberSummary=document.createElement('p');numberSummary.id=id+'-number-summary';numberSummary.setAttribute('aria-live','polite');form.append(numberSummary);}
  }
  const error=document.createElement('p');error.id=id+'-error';error.className='shop-message-error';error.setAttribute('role','status');error.setAttribute('aria-live','polite');form.append(error);
  const actions=document.createElement('div');actions.className='actions shop-dialog-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='btn secondary';cancel.textContent='Annulla';
  const submit=document.createElement('button');submit.type='submit';submit.className='btn';submit.textContent=confirmLabel;actions.append(cancel,submit);form.append(actions);dialog.append(form);
  let finished=false;
  function restoreFocus(){if(previousFocus?.isConnected&&!previousFocus.disabled)previousFocus.focus();}
  function finish(confirmed,value=null){
   if(finished)return;finished=true;activeDialog=null;
   if(dialog.open)dialog.close();dialog.remove();restoreFocus();resolve({confirmed,value});
  }
  cancel.addEventListener('click',()=>finish(false));closeButton.addEventListener('click',()=>finish(false));
  dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
  dialog.addEventListener('close',()=>finish(false));
  form.addEventListener('submit',event=>{
   event.preventDefault();let value=null;
   if(input){
    value=Number(input.value);
    if(!input.value.trim()||!Number.isInteger(value)||value<number.min||value>number.max){
     error.textContent=`Inserisci un numero intero da ${number.min} a ${number.max}.`;input.setAttribute('aria-invalid','true');input.focus();return;
    }
    input.removeAttribute('aria-invalid');
   }
   finish(true,value);
  });
  function updateNumberSummary(){
   if(!numberSummary)return;const value=Number(input.value);
   numberSummary.textContent=input.value.trim()&&Number.isInteger(value)&&value>=number.min&&value<=number.max?String(number.describe(value)):'';
  }
  input?.addEventListener('input',()=>{error.textContent='';input.removeAttribute('aria-invalid');updateNumberSummary();});
  updateNumberSummary();
  activeDialog=dialog;
  try{document.body.append(dialog);dialog.showModal();(input||cancel).focus();}
  catch(error){finished=true;activeDialog=null;dialog.remove();restoreFocus();reject(Error('Impossibile mostrare il riepilogo: '+error.message));}
 });
}

export async function confirmShopAction(options){return(await showShopDialog(options)).confirmed;}
