import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save} from 'lucide-react';
import {mergePages,OccurrenceItem} from './merge';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  const [winStart,setWinStart]=useState('2026-01-01T00:00:00Z');const [winEnd,setWinEnd]=useState('2027-01-01T00:00:00Z');const [dir,setDir]=useState<'asc'|'desc'>('asc');const [pageSize,setPageSize]=useState(10);
  const [occs,setOccs]=useState<OccurrenceItem[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [warnings,setWarnings]=useState<string[]>([]);
  useEffect(()=>{fetch('/api/schedules').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/schedules/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  useEffect(()=>{setOccs([]);setCursor(null);setWarnings([])},[selected,row?.revision]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/schedules/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/schedules/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function loadPage(first:boolean){
    if(!row)return;setStatus('Expanding');
    const params=new URLSearchParams({limit:String(pageSize)});
    if(first||!cursor){params.set('start',winStart);params.set('end',winEnd);params.set('dir',dir)}else params.set('cursor',cursor);
    const response=await fetch('/api/schedules/'+row.id+'/occurrences?'+params);
    const value=await response.json();
    if(!response.ok){setStatus('Preview failed: '+(value.error??response.status));if(response.status===409){setOccs([]);setCursor(null)}return}
    const merged=first?{items:value.occurrences as OccurrenceItem[],warnings:[]}:mergePages(occs,value.occurrences,value.dir);
    setOccs(merged.items);setWarnings(merged.warnings);setCursor(value.nextCursor);setStatus('Ready');
  }
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Recurrence Rule Studio</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside><aside className="pane"><h2>Occurrences</h2><div className="preview-controls"><label>From<input value={winStart} onChange={e=>setWinStart(e.target.value)}/></label><label>To<input value={winEnd} onChange={e=>setWinEnd(e.target.value)}/></label><label>Order<select value={dir} onChange={e=>setDir(e.target.value as 'asc'|'desc')}><option value="asc">asc</option><option value="desc">desc</option></select></label><label>Page size<input type="number" min={1} value={pageSize} onChange={e=>setPageSize(Math.max(1,Number(e.target.value)||1))}/></label><div className="toolbar"><button className="primary" onClick={()=>loadPage(true)}>Preview</button><button disabled={!cursor} onClick={()=>loadPage(false)}>More</button><span>{occs.length} loaded</span></div></div>{warnings.length>0&&<p className="warning">Merge warning: {[...new Set(warnings)].join(', ')} — server pages look inconsistent; results shown as received.</p>}<ol className="occurrences">{occs.map(o=><li key={o.id}><time>{o.start}</time><small>period {o.period.slice(0,10)}</small></li>)}</ol></aside></section></main>;
}
