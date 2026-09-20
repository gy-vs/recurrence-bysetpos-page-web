import express from 'express';
import {fileURLToPath} from 'node:url';
import {CursorError,ExpansionLimitError,MAX_WINDOW_MS,decodeCursor,encodeCursor,expandWindow,hashRule,paginate,parseRule} from './recurrence';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const defaultRows: RecordRow[] = [
  {id:'alpha',name:'Primary occurrence sets',revision:3,content:'DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary occurrence sets',revision:5,content:'DTSTART:20260105T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,SU;BYSETPOS=1;WKST=SU',updatedAt:new Date(1000).toISOString()},
];

const DEFAULT_LIMIT=50;
const MAX_LIMIT=5000;

export function createApp(seed?: RecordRow[]){
  const rows=(seed??defaultRows).map(row=>({...row}));
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"recurrence-rule",count:rows.length}));
  app.get('/api/schedules',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/schedules/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));const content=String(req.body.content??row.content);const {rule,diagnostics}=parseRule(content);res.json({id:row.id,revision:row.revision,lines:content.split(/\r?\n/).length,diagnostics,rule:rule?{freq:rule.freq,interval:rule.interval,byday:rule.byday,bysetpos:rule.bysetpos,wkst:rule.wkst}:null})});
  app.get('/api/schedules/:id/occurrences',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const {rule,diagnostics}=parseRule(row.content);
    if(!rule)return res.status(400).json({error:'invalid_rule',diagnostics});
    const q=req.query as Record<string,string|undefined>;
    const limitRaw=Number(q.limit??DEFAULT_LIMIT);
    if(!Number.isInteger(limitRaw)||limitRaw<1)return res.status(400).json({error:'bad_limit'});
    const limit=Math.min(limitRaw,MAX_LIMIT);
    // A cursor pins the rule revision+content, window and direction of the
    // original request, so a page sequence can never silently mix rule versions.
    let cursor=null;
    if(q.cursor){
      try{cursor=decodeCursor(q.cursor)}catch{return res.status(400).json({error:'bad_cursor'})}
      if(cursor.rev!==row.revision||cursor.hash!==hashRule(row.content))return res.status(409).json({error:'rule_changed',revision:row.revision});
      if(q.start&&Date.parse(q.start)!==Date.parse(cursor.window.start))return res.status(400).json({error:'cursor_mismatch'});
      if(q.end&&Date.parse(q.end)!==Date.parse(cursor.window.end))return res.status(400).json({error:'cursor_mismatch'});
      if(q.dir&&q.dir!==cursor.dir)return res.status(400).json({error:'cursor_mismatch'});
    }
    const dir=cursor?cursor.dir:(q.dir==='desc'?'desc':'asc');
    const start=new Date(cursor?cursor.window.start:String(q.start??''));
    const end=new Date(cursor?cursor.window.end:String(q.end??''));
    if(Number.isNaN(+start)||Number.isNaN(+end)||!(start<end))return res.status(400).json({error:'bad_window'});
    if(+end-+start>MAX_WINDOW_MS)return res.status(422).json({error:'window_too_large'});
    let all;
    try{all=expandWindow(rule,start,end)}catch(e){if(e instanceof ExpansionLimitError)return res.status(422).json({error:e.code});throw e}
    let result;
    try{result=paginate(all,limit,dir,cursor?{period:cursor.period,last:cursor.last}:null)}catch(e){if(e instanceof CursorError)return res.status(400).json({error:e.code});throw e}
    const nextCursor=result.next?encodeCursor({v:1,rev:row.revision,hash:hashRule(row.content),dir,window:{start:start.toISOString(),end:end.toISOString()},period:result.next.period,last:result.next.last}):null;
    res.json({id:row.id,revision:row.revision,window:{start:start.toISOString(),end:end.toISOString()},dir,occurrences:result.page.map(o=>({id:o.id,period:o.period.toISOString(),start:o.start.toISOString()})),nextCursor});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
