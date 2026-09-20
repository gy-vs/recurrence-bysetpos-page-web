import {createHash} from 'node:crypto';

// Recurrence expansion engine.
//
// Correctness contract (the bug this module exists to fix):
//   1. Candidates are generated for the FULL frequency period (month, week, ...).
//   2. BYSETPOS positions are applied against that complete period candidate
//      list — never against a list already clipped to a request window.
//   3. Only afterwards are occurrences intersected with the requested window.
// Cursors therefore anchor on (period boundary, occurrence identity) rather
// than a bare timestamp, so resuming mid-period re-evaluates the whole period.

export type Weekday='MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU';
export type Freq='DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY';

export interface Rule{
  freq:Freq;
  interval:number;            // >= 1
  byday:Weekday[]|null;
  bymonthday:number[]|null;   // 1..31 or -31..-1 (negative counts from month end)
  bymonth:number[]|null;      // 1..12
  bysetpos:number[]|null;     // non-zero positions within the full-period candidate list
  wkst:Weekday;
  dtstart:Date;
  until:Date|null;
  count:number|null;
}

export interface Diagnostic{line:number;level:'error'|'warning';message:string}

export interface Occurrence{period:Date;start:Date;id:string}

const DAY_MS=86_400_000;
const WEEKDAYS:Record<Weekday,number>={SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
const WEEKDAY_BY_INDEX:Weekday[]=['SU','MO','TU','WE','TH','FR','SA'];
const FREQS:Freq[]=['DAILY','WEEKLY','MONTHLY','YEARLY'];

// Safety bounds for a preview workbench: ~100 years of daily periods.
const MAX_PERIODS=40_000;
export const MAX_WINDOW_MS=36_600*DAY_MS;

export class ExpansionLimitError extends Error{
  constructor(public code:string){super(code);this.name='ExpansionLimitError'}
}
export class CursorError extends Error{
  constructor(public code:string){super(code);this.name='CursorError'}
}

// ---------- parsing ----------

export function parseDateTime(text:string):Date|null{
  const m=/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:\.\d{1,3})?Z$/.exec(text.trim());
  if(!m)return null;
  const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]));
  const ok=d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]
    &&d.getUTCHours()===+m[4]&&d.getUTCMinutes()===+m[5]&&d.getUTCSeconds()===+m[6];
  return ok?d:null;
}

function parseInts(value:string):number[]|null{
  const out:number[]=[];
  for(const part of value.split(',')){
    if(!/^-?\d+$/.test(part.trim()))return null;
    out.push(Number(part));
  }
  return out;
}

// Parses editor content of the form:
//   DTSTART:20260105T090000Z
//   RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1
export function parseRule(content:string):{rule:Rule|null;diagnostics:Diagnostic[]}{
  const diagnostics:Diagnostic[]=[];
  let dtstart:Date|null=null;
  let rruleLine=-1;
  const parts=new Map<string,string>();
  content.split(/\r?\n/).forEach((raw,i)=>{
    const line=raw.trim();
    if(!line)return;
    const colon=line.indexOf(':');
    if(colon===-1){diagnostics.push({line:i+1,level:'warning',message:'ignored line without a property:value shape'});return}
    const name=line.slice(0,colon).split(';')[0].trim().toUpperCase();
    const value=line.slice(colon+1).trim();
    if(name==='DTSTART'){
      const d=parseDateTime(value);
      if(!d)diagnostics.push({line:i+1,level:'error',message:`invalid DTSTART '${value}' (expected UTC, e.g. 20260105T090000Z)`});
      else dtstart=d;
    }else if(name==='RRULE'){
      if(rruleLine!==-1){diagnostics.push({line:i+1,level:'error',message:'duplicate RRULE'});return}
      rruleLine=i+1;
      for(const part of value.split(';')){
        const eq=part.indexOf('=');
        if(eq===-1){diagnostics.push({line:i+1,level:'error',message:`malformed RRULE part '${part}'`});continue}
        const key=part.slice(0,eq).trim().toUpperCase();
        if(parts.has(key))diagnostics.push({line:i+1,level:'error',message:`duplicate RRULE part ${key}`});
        parts.set(key,part.slice(eq+1).trim());
      }
    }else{
      diagnostics.push({line:i+1,level:'warning',message:`unrecognized property '${name}' ignored`});
    }
  });
  const at=rruleLine===-1?1:rruleLine;
  if(!dtstart)diagnostics.push({line:1,level:'error',message:'missing or invalid DTSTART'});
  if(rruleLine===-1)diagnostics.push({line:1,level:'error',message:'missing RRULE'});

  const freqRaw=parts.get('FREQ');
  const freq=FREQS.includes(freqRaw as Freq)?freqRaw as Freq:null;
  if(rruleLine!==-1&&!freq)diagnostics.push({line:at,level:'error',message:`RRULE requires FREQ=${FREQS.join('|')}`});

  let interval=1;
  if(parts.has('INTERVAL')){
    const n=Number(parts.get('INTERVAL'));
    if(!Number.isInteger(n)||n<1)diagnostics.push({line:at,level:'error',message:`INTERVAL must be a positive integer, got '${parts.get('INTERVAL')}'`});
    else interval=n;
  }

  let byday:Weekday[]|null=null;
  if(parts.has('BYDAY')){
    const codes=parts.get('BYDAY')!.split(',').map(s=>s.trim().toUpperCase());
    const bad=codes.find(c=>!(c in WEEKDAYS));
    if(bad!==undefined){
      const hint=/^-?\d+(MO|TU|WE|TH|FR|SA|SU)$/.test(bad)?' (ordinal BYDAY is not supported; express it with BYSETPOS)':'';
      diagnostics.push({line:at,level:'error',message:`invalid BYDAY code '${bad}'${hint}`});
    }else byday=codes as Weekday[];
  }

  let bymonthday:number[]|null=null;
  if(parts.has('BYMONTHDAY')){
    const ns=parseInts(parts.get('BYMONTHDAY')!);
    if(!ns||ns.some(n=>n===0||n>31||n<-31))diagnostics.push({line:at,level:'error',message:'BYMONTHDAY entries must be in 1..31 or -31..-1'});
    else bymonthday=ns;
  }

  let bymonth:number[]|null=null;
  if(parts.has('BYMONTH')){
    const ns=parseInts(parts.get('BYMONTH')!);
    if(!ns||ns.some(n=>n<1||n>12))diagnostics.push({line:at,level:'error',message:'BYMONTH entries must be in 1..12'});
    else bymonth=ns;
  }

  let bysetpos:number[]|null=null;
  if(parts.has('BYSETPOS')){
    const ns=parseInts(parts.get('BYSETPOS')!);
    if(!ns||ns.some(n=>n===0||n>366||n<-366))diagnostics.push({line:at,level:'error',message:'BYSETPOS entries must be non-zero positions in 1..366 or -366..-1'});
    else bysetpos=ns;
  }

  let wkst:Weekday='MO';
  if(parts.has('WKST')){
    const code=parts.get('WKST')!.toUpperCase();
    if(!(code in WEEKDAYS))diagnostics.push({line:at,level:'error',message:`invalid WKST '${parts.get('WKST')}'`});
    else wkst=code as Weekday;
  }

  let until:Date|null=null;
  if(parts.has('UNTIL')){
    until=parseDateTime(parts.get('UNTIL')!);
    if(!until)diagnostics.push({line:at,level:'error',message:`invalid UNTIL '${parts.get('UNTIL')}'`});
  }

  let count:number|null=null;
  if(parts.has('COUNT')){
    const n=Number(parts.get('COUNT'));
    if(!Number.isInteger(n)||n<1)diagnostics.push({line:at,level:'error',message:`COUNT must be a positive integer, got '${parts.get('COUNT')}'`});
    else count=n;
  }

  for(const key of parts.keys()){
    if(!['FREQ','INTERVAL','BYDAY','BYMONTHDAY','BYMONTH','BYSETPOS','WKST','UNTIL','COUNT'].includes(key))
      diagnostics.push({line:at,level:'warning',message:`unrecognized RRULE part ${key} ignored`});
  }

  if(diagnostics.some(d=>d.level==='error')||!dtstart||!freq)return{rule:null,diagnostics};
  return{rule:{freq,interval,byday,bymonthday,bymonth,bysetpos,wkst,dtstart,until,count},diagnostics};
}

export function hashRule(content:string):string{
  return createHash('sha256').update(content).digest('hex').slice(0,16);
}

// ---------- period arithmetic (all UTC) ----------

function startOfDayUTC(d:Date):Date{
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
}

function weekStartOf(d:Date,wkst:Weekday):Date{
  const day=startOfDayUTC(d);
  const back=(day.getUTCDay()-WEEKDAYS[wkst]+7)%7;
  return new Date(day.getTime()-back*DAY_MS);
}

// Start (00:00 UTC) of the frequency period containing `d`, aligned so that
// the period containing DTSTART is period 0 and INTERVAL counts from there.
export function periodStartOf(rule:Rule,d:Date):Date{
  const t0=rule.dtstart;
  switch(rule.freq){
    case 'DAILY':{
      const base=startOfDayUTC(t0).getTime();
      const days=Math.floor((startOfDayUTC(d).getTime()-base)/DAY_MS);
      return new Date(base+Math.floor(days/rule.interval)*rule.interval*DAY_MS);
    }
    case 'WEEKLY':{
      const base=weekStartOf(t0,rule.wkst).getTime();
      const weeks=Math.floor((startOfDayUTC(d).getTime()-base)/(7*DAY_MS));
      return new Date(base+Math.floor(weeks/rule.interval)*rule.interval*7*DAY_MS);
    }
    case 'MONTHLY':{
      const diff=(d.getUTCFullYear()-t0.getUTCFullYear())*12+(d.getUTCMonth()-t0.getUTCMonth());
      const k=Math.floor(diff/rule.interval);
      return new Date(Date.UTC(t0.getUTCFullYear(),t0.getUTCMonth()+k*rule.interval,1));
    }
    case 'YEARLY':{
      const diff=d.getUTCFullYear()-t0.getUTCFullYear();
      const k=Math.floor(diff/rule.interval);
      return new Date(Date.UTC(t0.getUTCFullYear()+k*rule.interval,0,1));
    }
  }
}

export function nextPeriod(rule:Rule,p:Date):Date{
  switch(rule.freq){
    case 'DAILY':return new Date(p.getTime()+rule.interval*DAY_MS);
    case 'WEEKLY':return new Date(p.getTime()+rule.interval*7*DAY_MS);
    case 'MONTHLY':return new Date(Date.UTC(p.getUTCFullYear(),p.getUTCMonth()+rule.interval,1));
    case 'YEARLY':return new Date(Date.UTC(p.getUTCFullYear()+rule.interval,0,1));
  }
}

// ---------- candidate generation & BYSETPOS ----------

function daysInMonthUTC(y:number,m:number):number{
  return new Date(Date.UTC(y,m+1,0)).getUTCDate();
}

// Every candidate instant inside one full period, ascending, before BYSETPOS.
function candidatesInPeriod(rule:Rule,p:Date):Date[]{
  const t0=rule.dtstart;
  const at=(y:number,m:number,dom:number)=>new Date(Date.UTC(y,m,dom,t0.getUTCHours(),t0.getUTCMinutes(),t0.getUTCSeconds()));
  let out:Date[]=[];
  switch(rule.freq){
    case 'DAILY':
      out=[at(p.getUTCFullYear(),p.getUTCMonth(),p.getUTCDate())];
      break;
    case 'WEEKLY':{
      const codes=rule.byday??[WEEKDAY_BY_INDEX[t0.getUTCDay()]];
      const base=WEEKDAYS[rule.wkst];
      for(const c of codes){
        const off=(WEEKDAYS[c]-base+7)%7;
        const day=new Date(p.getTime()+off*DAY_MS);
        out.push(at(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate()));
      }
      break;
    }
    case 'MONTHLY':
      out=monthDayCandidates(rule,p.getUTCFullYear(),p.getUTCMonth(),at);
      break;
    case 'YEARLY':{
      const months=rule.bymonth??[t0.getUTCMonth()+1];
      for(const mo of months)out.push(...monthDayCandidates(rule,p.getUTCFullYear(),mo-1,at));
      break;
    }
  }
  if(rule.freq!=='YEARLY'&&rule.bymonth)out=out.filter(d=>rule.bymonth!.includes(d.getUTCMonth()+1));
  if(rule.freq==='DAILY'&&rule.byday)out=out.filter(d=>rule.byday!.includes(WEEKDAY_BY_INDEX[d.getUTCDay()]));
  const seen=new Set<number>();
  return out.filter(d=>{const t=d.getTime();if(seen.has(t))return false;seen.add(t);return true})
    .sort((a,b)=>a.getTime()-b.getTime());
}

function monthDayCandidates(rule:Rule,y:number,m:number,at:(y:number,m:number,dom:number)=>Date):Date[]{
  const dim=daysInMonthUTC(y,m);
  let days:number[];
  if(rule.bymonthday){
    days=rule.bymonthday.map(n=>n>0?n:dim+1+n).filter(dom=>dom>=1&&dom<=dim);
    if(rule.byday)days=days.filter(dom=>rule.byday!.includes(WEEKDAY_BY_INDEX[new Date(Date.UTC(y,m,dom)).getUTCDay()]));
  }else if(rule.byday){
    days=[];
    for(let dom=1;dom<=dim;dom++)if(rule.byday.includes(WEEKDAY_BY_INDEX[new Date(Date.UTC(y,m,dom)).getUTCDay()]))days.push(dom);
  }else{
    const dom=rule.dtstart.getUTCDate();
    days=dom<=dim?[dom]:[];
  }
  return days.map(dom=>at(y,m,dom));
}

// Positions are 1-based against the complete period candidate list;
// negatives count back from the end of the period.
export function applyBysetpos(candidates:Date[],positions:number[]):Date[]{
  const n=candidates.length;
  const picked=new Set<number>();
  for(const pos of positions){
    const i=pos>0?pos-1:n+pos;
    if(i>=0&&i<n)picked.add(i);
  }
  return[...picked].sort((a,b)=>a-b).map(i=>candidates[i]);
}

// The selected occurrences of one full period. DTSTART/UNTIL bounds are
// applied after BYSETPOS so positions stay relative to the period.
export function occurrencesInPeriod(rule:Rule,periodStart:Date):Date[]{
  let cands=candidatesInPeriod(rule,periodStart);
  if(rule.bysetpos)cands=applyBysetpos(cands,rule.bysetpos);
  return cands.filter(d=>d>=rule.dtstart&&(!rule.until||d<=rule.until));
}

// ---------- window expansion ----------

export function occurrenceId(period:Date,start:Date):string{
  return `${period.toISOString()}#${start.toISOString()}`;
}

// All occurrences in [start, end), ascending. BYSETPOS has already been
// applied per full period by the time the window intersection happens here.
export function expandWindow(rule:Rule,start:Date,end:Date):Occurrence[]{
  const out:Occurrence[]=[];
  let scanned=0;
  let seen=0;
  // COUNT bounds the whole recurrence set, so counted rules must be tallied
  // from DTSTART; uncounted rules can start directly at the window.
  let p=rule.count!==null?periodStartOf(rule,rule.dtstart):periodStartOf(rule,start);
  while(p<end){
    if(++scanned>MAX_PERIODS)throw new ExpansionLimitError('range_too_large');
    const periodStart=p;
    for(const s of occurrencesInPeriod(rule,periodStart)){
      if(rule.count!==null){
        seen++;
        if(seen>rule.count)return out;
      }
      if(s>=start&&s<end)out.push({period:periodStart,start:s,id:occurrenceId(periodStart,s)});
    }
    p=nextPeriod(rule,p);
  }
  return out;
}

// ---------- cursor ----------

// The cursor anchors on the period boundary AND the identity of the last
// emitted occurrence — never on a bare timestamp — so a resume that lands
// mid-period still re-evaluates that period as a whole.
export interface CursorData{
  v:1;
  rev:number;
  hash:string;
  dir:'asc'|'desc';
  window:{start:string;end:string};
  period:string; // period boundary containing `last`
  last:string;   // start of the last emitted occurrence
}

export function encodeCursor(c:CursorData):string{
  return Buffer.from(JSON.stringify(c),'utf8').toString('base64url');
}

function isIso(s:unknown):s is string{
  return typeof s==='string'&&!Number.isNaN(Date.parse(s));
}

export function decodeCursor(text:string):CursorData{
  try{
    const c=JSON.parse(Buffer.from(text,'base64url').toString('utf8'));
    if(c&&c.v===1&&typeof c.rev==='number'&&typeof c.hash==='string'
      &&(c.dir==='asc'||c.dir==='desc')
      &&c.window&&isIso(c.window.start)&&isIso(c.window.end)
      &&isIso(c.period)&&isIso(c.last))return c as CursorData;
  }catch{/* fall through */}
  throw new CursorError('bad_cursor');
}

// Slices a page out of the fully expanded window. Because both one-shot and
// paged reads expand the same window first, concatenated pages are identical
// to a one-shot read by construction.
export function paginate(
  all:Occurrence[],
  limit:number,
  dir:'asc'|'desc',
  cursor:{period:string;last:string}|null,
):{page:Occurrence[];next:{period:string;last:string}|null}{
  let rest:Occurrence[];
  if(!cursor){
    rest=dir==='asc'?all:[...all].reverse();
  }else{
    const id=occurrenceId(new Date(cursor.period),new Date(cursor.last));
    const idx=all.findIndex(o=>o.id===id);
    if(idx===-1)throw new CursorError('stale_cursor');
    rest=dir==='asc'?all.slice(idx+1):all.slice(0,idx).reverse();
  }
  const page=rest.slice(0,limit);
  if(rest.length<=limit||page.length===0)return{page,next:null};
  const tail=page[page.length-1];
  return{page,next:{period:tail.period.toISOString(),last:tail.start.toISOString()}};
}
