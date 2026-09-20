export interface OccurrenceItem{id:string;period:string;start:string}
export interface MergeResult{items:OccurrenceItem[];warnings:string[]}

// Merges a fetched page into the accumulated preview list.
//
// Dedupe is by occurrence identity ONLY: it absorbs genuine overlap between
// pages (e.g. a re-fetched page). It must never mask a server-side omission,
// so items are kept strictly in arrival order — never re-sorted, never
// interpolated, and never dropped unless the exact identity was already seen.
// Anything that breaks the expected monotonic order is surfaced as a warning
// instead of being silently repaired.
export function mergePages(existing:OccurrenceItem[],page:OccurrenceItem[],dir:'asc'|'desc'):MergeResult{
  const warnings:string[]=[];
  const seen=new Set(existing.map(o=>o.id));
  const fresh:OccurrenceItem[]=[];
  for(const o of page){
    if(seen.has(o.id))continue; // exact identity already present: overlap, drop the copy
    seen.add(o.id);
    fresh.push(o);
  }
  const comesBefore=(a:OccurrenceItem,b:OccurrenceItem)=>dir==='asc'?a.start<b.start:a.start>b.start;
  for(let i=1;i<fresh.length;i++){
    if(!comesBefore(fresh[i-1],fresh[i])){warnings.push('page_not_monotonic');break}
  }
  const anchor=dir==='asc'?existing[existing.length-1]:existing[0];
  const edge=dir==='asc'?fresh[0]:fresh[fresh.length-1];
  if(anchor&&edge&&!comesBefore(anchor,edge))warnings.push('page_does_not_extend_sequence');
  const items=dir==='asc'?[...existing,...fresh]:[...fresh,...existing];
  return{items,warnings};
}
