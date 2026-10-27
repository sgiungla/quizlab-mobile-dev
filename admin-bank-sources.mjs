function canonical(value){return JSON.stringify(sort(value));}
function sort(value){if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])]));return value;}
export function groupBankSources(rows){
 const groups=new Map();
 for(const row of rows){if(!groups.has(row.courseId))groups.set(row.courseId,[]);const group=groups.get(row.courseId),same=group.find(x=>x.subject===row.subject&&canonical(x.bank)===canonical(row.bank));
  if(same){same.provenance='Locale e cloud · contenuti identici';same.sharedSource=true;}
  else group.push({...row});
 }
 return [...groups.values()].flatMap(group=>group.map(row=>({...row,sourceVariants:group.length})));
}
