import {useEffect,useMemo,useState} from 'react';
import {ChevronLeft, ChevronRight, FlaskConical, Play, Save, TableProperties} from 'lucide-react';
import {
  mergeOccurrencePages,
  parseRule,
  type Occurrence,
  type OccurrencePage,
  type PageDirection,
} from '../shared/recurrence';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

interface PreviewState {
  ruleText:string;
  from:string;
  to:string;
  mode:'paged'|'all';
  direction:PageDirection;
  pages:OccurrencePage[];
  deduplicatedAtSeams:number;
  loading:boolean;
  error:string|null;
}

const PAGE_LIMIT=5;

function previewWindow(ruleText:string){
  const rule=parseRule(ruleText);
  const start=rule.dtstart;
  const from=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),1));
  const to=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+12,0,23,59,59,999));
  return {from,to};
}

async function requestPreviewPage(
  options:{
    ruleText:string;
    from:string;
    to:string;
    direction:PageDirection;
    cursor:string|null;
    row:Row|null;
    expandAll:boolean;
  },
):Promise<OccurrencePage>{
  const savedRevision=options.row&&options.row.content===options.ruleText?options.row.revision:null;
  let response:Response;
  if(savedRevision!==null){
    const params=new URLSearchParams({
      revision:String(savedRevision),
      from:options.from,
      to:options.to,
    });
    if(options.expandAll){
      params.set('expand','all');
    }else{
      params.set('limit',String(PAGE_LIMIT));
      params.set('direction',options.direction);
      if(options.cursor)params.set('cursor',options.cursor);
    }
    response=await fetch(`/api/schedules/${options.row!.id}/occurrences?${params}`);
  }else{
    response=await fetch('/api/occurrences/preview',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(options.expandAll?{
        rule:options.ruleText,
        from:options.from,
        to:options.to,
        expand:'all',
      }:{
        rule:options.ruleText,
        from:options.from,
        to:options.to,
        limit:PAGE_LIMIT,
        direction:options.direction,
        cursor:options.cursor,
      }),
    });
  }
  const value=await response.json();
  if(!response.ok)throw new Error(value.message??value.error??'Occurrence preview failed');
  return value as OccurrencePage;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const [preview,setPreview]=useState<PreviewState|null>(null);

  useEffect(()=>{
    fetch('/api/schedules').then(r=>r.json()).then(setItems)
  },[]);

  useEffect(()=>{
    setStatus('Loading');
    setPreview(null);
    setAnalysis(null);
    fetch('/api/schedules/'+selected).then(r=>r.json()).then((value:Row)=>{
      setRow(value);
      setDraft(value.content);
      setStatus('Loaded');
    })
  },[selected]);

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/schedules/'+row.id,{
      method:'PUT',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({content:draft,revision:row.revision}),
    });
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);
    setPreview(null);
    setStatus('Saved');
  }

  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/schedules/'+row.id+'/analyze',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({content:draft}),
    });
    setAnalysis(await response.json());
    setStatus('Ready');
  }

  async function runPreview(direction:PageDirection,expandAll=false){
    if(!row)return;
    setStatus('Previewing');
    try{
      const window=previewWindow(draft);
      const first=await requestPreviewPage({
        ruleText:draft,
        from:window.from.toISOString(),
        to:window.to.toISOString(),
        direction,
        cursor:null,
        row,
        expandAll,
      });
      setPreview({
        ruleText:draft,
        from:first.from,
        to:first.to,
        mode:expandAll?'all':'paged',
        direction,
        pages:[first],
        deduplicatedAtSeams:0,
        loading:false,
        error:null,
      });
      setStatus('Preview ready');
    }catch(error){
      setPreview({
        ruleText:draft,
        from:'',
        to:'',
        mode:expandAll?'all':'paged',
        direction,
        pages:[],
        deduplicatedAtSeams:0,
        loading:false,
        error:error instanceof Error?error.message:String(error),
      });
      setStatus('Preview failed');
    }
  }

  async function loadNextPage(){
    if(!row||!preview||preview.mode!=='paged')return;
    const last=preview.pages[preview.pages.length-1];
    if(!last?.nextCursor)return;
    setPreview({...preview,loading:true,error:null});
    try{
      const next=await requestPreviewPage({
        ruleText:preview.ruleText,
        from:preview.from,
        to:preview.to,
        direction:preview.direction,
        cursor:last.nextCursor,
        row,
        expandAll:false,
      });
      const pages=[...preview.pages,next];
      const before=pages.reduce((sum,page)=>sum+page.occurrences.length,0);
      const merged=mergeOccurrencePages(pages);
      setPreview({
        ...preview,
        pages,
        deduplicatedAtSeams:before-merged.length,
        loading:false,
      });
    }catch(error){
      setPreview({
        ...preview,
        loading:false,
        error:error instanceof Error?error.message:String(error),
      });
    }
  }

  const mergedOccurrences=useMemo<Occurrence[]|null>(()=>{
    if(!preview)return null;
    if(preview.error)return null;
    try{
      return preview.mode==='all'
        ?preview.pages[0]?.occurrences??[]
        :mergeOccurrencePages(preview.pages);
    }catch(error){
      return [];
    }
  },[preview]);

  const lastPage=preview?.pages[preview.pages.length-1];
  const stale=preview!==null&&preview.ruleText!==draft;
  const firstOccurrence=mergedOccurrences?.[0];
  const lastOccurrence=mergedOccurrences?.[mergedOccurrences.length-1];

  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/>
      <strong>Recurrence Rule Studio</strong>
      <small>Local workspace</small>
    </header>
    <section className="workspace">
      <aside className="pane">
        <h2>Items</h2>
        <div className="list">
          {items.map(item=><button
            className={item.id===selected?'active':''}
            onClick={()=>setSelected(item.id)}
            key={item.id}
          >
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><Play size={15}/>Analyze</button>
          <span>{status}</span>
        </div>
        <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/>
        <div className="preview">
          <div className="preview-head">
            <h2><TableProperties size={17}/>Occurrence preview</h2>
            <div className="preview-actions">
              <button className="load-more-button" onClick={()=>runPreview('forward')} title="Read forward from window start">
                <ChevronRight size={15}/>Forward pages
              </button>
              <button className="load-more-button" onClick={()=>runPreview('backward')} title="Read backward from window end">
                <ChevronLeft size={15}/>Backward pages
              </button>
              <button onClick={()=>runPreview('forward',true)}>Expand window once</button>
            </div>
          </div>
          {!preview&&<p className="hint">Run a preview to expand BYDAY/BYSETPOS over complete frequency periods before intersecting the window.</p>}
          {preview&&<>
            {stale&&<div className="warning">Draft changed since this preview. Run it again before paging.</div>}
            {preview.error&&<div className="error">{preview.error}</div>}
            {!preview.error&&<div className="preview-meta">
              <span>revision {lastPage?.revision}</span>
              <span>{mergedOccurrences?.length??0} occurrences</span>
              <span>{preview.deduplicatedAtSeams} seam {preview.deduplicatedAtSeams===1?'duplicate':'duplicates'}</span>
              <span>{preview.from} → {preview.to}</span>
              {preview.mode==='paged'&&<span>{preview.direction}</span>}
            </div>}
            {!preview.error&&mergedOccurrences&&mergedOccurrences.length===0&&<p className="hint">No occurrences in this window.</p>}
            {!preview.error&&<ol className="occurrences">
              {(mergedOccurrences??[]).map(occurrence=><li key={occurrence.id}>
                <code>{occurrence.startAt}</code>
                <small>period {occurrence.periodStart} · #{occurrence.indexInPeriod} · id {occurrence.id}</small>
              </li>)}
            </ol>}
            {preview.mode==='paged'&&lastPage?.pageInfo.hasMore&&<button
              className="load-more"
              disabled={preview.loading||stale}
              onClick={loadNextPage}
            >{preview.loading?'Loading…':preview.direction==='forward'?'Load next page':'Load previous page'}</button>}
            {!preview.error&&mergedOccurrences&&mergedOccurrences.length>0&&<p className="hint">
              {preview.direction==='forward'||preview.mode==='all'
                ?`Range begins at ${firstOccurrence?.startAt} and ends at ${lastOccurrence?.startAt}.`
                :`Reading newest first from ${firstOccurrence?.startAt}; oldest shown is ${lastOccurrence?.startAt}.`}
            </p>}
          </>}
        </div>
      </section>
      <aside className="pane">
        <h2>Inspection</h2>
        <span className="pill">{selected}</span>
        <pre>{JSON.stringify(analysis??row,null,2)}</pre>
      </aside>
    </section>
  </main>;
}
