import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  expandPage,
  oneShotPage,
  parseInstant,
  parseRule,
  RecurrenceError,
} from '../shared/recurrence.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {
    id:'alpha',
    name:'Primary occurrence sets',
    revision:3,
    content:[
      'DTSTART:20260105T090000Z',
      'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    ].join('\n'),
    updatedAt:new Date(0).toISOString(),
  },
  {
    id:'beta',
    name:'Secondary occurrence sets',
    revision:5,
    content:[
      'DTSTART:20260101T100000Z',
      'RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO,WE,FR;BYSETPOS=3',
    ].join('\n'),
    updatedAt:new Date(1000).toISOString(),
  },
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"recurrence-rule",count:rows.length}));
  app.get('/api/schedules',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/schedules/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/schedules/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  app.get('/api/schedules/:id/occurrences',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const revision=String(req.query.revision??'');
    if(revision!==String(row.revision)){
      return res.status(409).json({error:'revision_conflict',current:row.revision});
    }
    const window=readWindow(req.query.from,req.query.to);
    const rule=parseRule(row.content,row.revision);
    if(req.query.expand==='all')return res.json(oneShotPage(rule,window));
    const limit=readLimit(req.query.limit);
    return res.json(expandPage(rule,{
      ...window,
      limit,
      direction:req.query.direction==='backward'?'backward':'forward',
      cursor:typeof req.query.cursor==='string'?req.query.cursor:null,
    }));
  });

  app.post('/api/occurrences/preview',(req,res)=>{
    const body=req.body??{};
    const ruleText=String(body.rule??'');
    const window=readWindow(body.from,body.to);
    const rule=parseRule(ruleText);
    if(body.expand==='all')return res.json(oneShotPage(rule,window));
    const limit=readLimit(body.limit);
    return res.json(expandPage(rule,{
      ...window,
      limit,
      direction:body.direction==='backward'?'backward':'forward',
      cursor:typeof body.cursor==='string'?body.cursor:null,
    }));
  });

  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(error instanceof RecurrenceError){
      return res.status(error.status).json({error:'invalid_rule',message:error.message});
    }
    throw error;
  });

  return app;
}

function readWindow(fromValue:unknown,toValue:unknown){
  if(typeof fromValue!=='string'||typeof toValue!=='string'){
    throw new RecurrenceError(400,'Both from and to are required');
  }
  return {from:parseInstant(fromValue),to:parseInstant(toValue)};
}

function readLimit(value:unknown):number{
  if(typeof value!=='string'&&typeof value!=='number'){
    throw new RecurrenceError(400,'limit is required unless expand=all');
  }
  const limit=Number(value);
  if(!Number.isInteger(limit)||limit<1||limit>200){
    throw new RecurrenceError(400,'limit must be an integer between 1 and 200');
  }
  return limit;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
