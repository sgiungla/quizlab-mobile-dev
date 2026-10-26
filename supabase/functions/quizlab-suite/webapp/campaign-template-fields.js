export const CAMPAIGN_FIELDS=Object.freeze([
 {key:'nome_utente',label:'Nome nel profilo',requirement:'Usa il nome nel profilo, oppure «studente».'},
 {key:'nome_materia',label:'Nome della materia',requirement:'Scegli una materia, oppure un obiettivo/esame relativo a una materia. Se è l’unica materia disponibile, la scelta è automatica.'},
 {key:'domande_rimanenti',label:'Domande della banca ancora da affrontare',requirement:'Domande uniche non ancora svolte nella banca selezionata, oppure in tutte le materie. Richiede dati sincronizzati verificabili.'},
 {key:'domande_da_ripassare',label:'Domande da ripassare',requirement:'Errori ancora da recuperare e ripassi periodici effettivamente dovuti. Richiede dati sincronizzati verificabili.'},
 {key:'percentuale_completamento',label:'Copertura della banca (%)',requirement:'Percentuale di domande uniche affrontate nella banca, oppure nel totale delle materie. Richiede dati sincronizzati verificabili.'},
 {key:'giorni_esame',label:'Giorni prima dell’esame',requirement:'Scegli un esame futuro registrato. La scelta è automatica solo se ne esiste uno compatibile.'},
 {key:'giorni_obiettivo',label:'Giorni prima della scadenza dell’obiettivo',requirement:'Richiede un obiettivo con scadenza, non sospeso, trascorso o già raggiunto.'},
 {key:'giorni_inattivita',label:'Giorni senza studio',requirement:'Giorni di calendario nel fuso dello studente, dall’ultima attività significativa di studio. Richiede dati sincronizzati verificabili.'},
 {key:'obiettivo',label:'Titolo dell’obiettivo',requirement:'Scegli un obiettivo registrato. La scelta è automatica solo se ne esiste uno compatibile.'},
 {key:'traguardo',label:'Traguardo ottenuto',requirement:'Scegli un riconoscimento realmente assegnato al destinatario. Nessun traguardo viene creato dal messaggio.'}
]);
export function campaignVariables(...texts){return [...new Set(texts.flatMap(t=>[...String(t||'').matchAll(/\{([a-z_]+)\}/g)].map(m=>m[1])))];}
