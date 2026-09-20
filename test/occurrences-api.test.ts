import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const WEEKDAY_SETPOS='DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1';

function makeApp(content:string){
  return createApp([{id:'r1',name:'rule',revision:1,content,updatedAt:new Date(0).toISOString()}]);
}
async function oneShot(app:ReturnType<typeof makeApp>,start:string,end:string,dir:'asc'|'desc'='asc'){
  const res=await request(app).get('/api/schedules/r1/occurrences').query({start,end,dir,limit:5000}).expect(200);
  expect(res.body.nextCursor).toBeNull();
  return res.body.occurrences as {id:string;period:string;start:string}[];
}
async function paged(app:ReturnType<typeof makeApp>,start:string,end:string,limit:number,dir:'asc'|'desc'='asc'){
  const out:{id:string;period:string;start:string}[]=[];
  let cursor:string|null=null;
  let pages=0;
  do{
    const query:Record<string,string|number>=cursor?{cursor,limit}:{start,end,dir,limit};
    const res=await request(app).get('/api/schedules/r1/occurrences').query(query).expect(200);
    out.push(...res.body.occurrences);
    cursor=res.body.nextCursor;
    if(++pages>500)throw new Error('pagination did not terminate');
  }while(cursor);
  return{items:out,pages};
}
const ids=(list:{id:string}[])=>list.map(o=>o.id);
const starts=(list:{start:string}[])=>list.map(o=>o.start);

describe('occurrences API',()=>{
  it('paginated concatenation equals one-shot expansion for every page size (asc and desc)',async()=>{
    const app=makeApp(WEEKDAY_SETPOS);
    const start='2026-01-01T00:00:00Z',end='2027-03-01T00:00:00Z';
    const expected=ids(await oneShot(app,start,end));
    expect(expected).toHaveLength(28); // 14 months x (first + last weekday)
    for(const limit of [1,2,3,5,7,28,100]){
      const {items,pages}=await paged(app,start,end,limit);
      expect(pages).toBe(Math.ceil(28/limit));
      expect(ids(items)).toEqual(expected);
    }
    const expectedDesc=ids(await oneShot(app,start,end,'desc'));
    expect(expectedDesc).toEqual([...expected].reverse());
    for(const limit of [1,5]){
      const {items}=await paged(app,start,end,limit,'desc');
      expect(ids(items)).toEqual(expectedDesc);
    }
  });

  it('resumes mid-period from the cursor without re-applying BYSETPOS to a clipped remainder',async()=>{
    const app=makeApp(WEEKDAY_SETPOS);
    const start='2026-01-15T00:00:00Z',end='2026-04-01T00:00:00Z';
    const {items,pages}=await paged(app,start,end,1);
    expect(pages).toBe(5);
    expect(starts(items)).toEqual(['2026-01-30T09:00:00.000Z','2026-02-02T09:00:00.000Z','2026-02-27T09:00:00.000Z','2026-03-02T09:00:00.000Z','2026-03-31T09:00:00.000Z']);
    expect(ids(items)).toEqual(ids(await oneShot(app,start,end)));
  });

  it('keeps BYSETPOS relative to the period across a cross-month window',async()=>{
    const first=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1');
    expect(starts(await oneShot(first,'2026-01-15T00:00:00Z','2026-04-15T00:00:00Z')))
      .toEqual(['2026-02-02T09:00:00.000Z','2026-03-02T09:00:00.000Z','2026-04-01T09:00:00.000Z']);
    const last=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1');
    expect(starts(await oneShot(last,'2026-01-15T00:00:00Z','2026-04-15T00:00:00Z')))
      .toEqual(['2026-01-30T09:00:00.000Z','2026-02-27T09:00:00.000Z','2026-03-31T09:00:00.000Z']);
  });

  it('supports multiple BYDAY values with positive and negative BYSETPOS',async()=>{
    const app=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,FR;BYSETPOS=1,-1');
    expect(starts(await oneShot(app,'2026-01-01T00:00:00Z','2026-04-01T00:00:00Z')))
      .toEqual(['2026-01-02T09:00:00.000Z','2026-01-30T09:00:00.000Z','2026-02-02T09:00:00.000Z','2026-02-27T09:00:00.000Z','2026-03-02T09:00:00.000Z','2026-03-30T09:00:00.000Z']);
  });

  it('lets WKST steer weekly BYSETPOS selection',async()=>{
    const monday=makeApp('DTSTART:20260105T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,SU;BYSETPOS=1;WKST=MO');
    expect(starts(await oneShot(monday,'2026-01-01T00:00:00Z','2026-02-03T00:00:00Z')))
      .toEqual(['2026-01-05T09:00:00.000Z','2026-01-12T09:00:00.000Z','2026-01-19T09:00:00.000Z','2026-01-26T09:00:00.000Z','2026-02-02T09:00:00.000Z']);
    const sunday=makeApp('DTSTART:20260105T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,SU;BYSETPOS=1;WKST=SU');
    expect(starts(await oneShot(sunday,'2026-01-01T00:00:00Z','2026-02-03T00:00:00Z')))
      .toEqual(['2026-01-11T09:00:00.000Z','2026-01-18T09:00:00.000Z','2026-01-25T09:00:00.000Z','2026-02-01T09:00:00.000Z']);
  });

  it('paginates cleanly across empty periods',async()=>{
    const app=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31');
    const start='2026-01-01T00:00:00Z',end='2027-01-01T00:00:00Z';
    const expected=starts(await oneShot(app,start,end));
    expect(expected).toEqual(['2026-01-31T09:00:00.000Z','2026-03-31T09:00:00.000Z','2026-05-31T09:00:00.000Z','2026-07-31T09:00:00.000Z','2026-08-31T09:00:00.000Z','2026-10-31T09:00:00.000Z','2026-12-31T09:00:00.000Z']);
    const {items,pages}=await paged(app,start,end,2);
    expect(pages).toBe(4);
    expect(starts(items)).toEqual(expected);
  });

  it('handles BYSETPOS over empty candidate sets, including leap February',async()=>{
    const rule='DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=29,30,31;BYSETPOS=-1';
    expect(starts(await oneShot(makeApp(rule),'2026-01-01T00:00:00Z','2026-04-01T00:00:00Z')))
      .toEqual(['2026-01-31T09:00:00.000Z','2026-03-31T09:00:00.000Z']); // Feb 2026 has no 29/30/31
    expect(starts(await oneShot(makeApp(rule),'2028-01-01T00:00:00Z','2028-04-01T00:00:00Z')))
      .toEqual(['2028-01-31T09:00:00.000Z','2028-02-29T09:00:00.000Z','2028-03-31T09:00:00.000Z']);
  });

  it('includes an occurrence exactly on the window start and excludes one exactly on the end',async()=>{
    const app=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1');
    expect(starts(await oneShot(app,'2026-02-02T09:00:00Z','2026-04-01T00:00:00Z'))[0]).toBe('2026-02-02T09:00:00.000Z');
    expect(starts(await oneShot(app,'2026-01-01T00:00:00Z','2026-02-02T09:00:00Z'))).toEqual(['2026-01-01T09:00:00.000Z']);
    expect(starts(await oneShot(app,'2026-01-01T09:00:00Z','2026-03-02T09:00:00Z')))
      .toEqual(['2026-01-01T09:00:00.000Z','2026-02-02T09:00:00.000Z']);
  });

  it('honors INTERVAL, UNTIL and COUNT',async()=>{
    const interval=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=FR;BYSETPOS=-1');
    expect(starts(await oneShot(interval,'2026-01-01T00:00:00Z','2027-01-01T00:00:00Z')))
      .toEqual(['2026-01-30T09:00:00.000Z','2026-04-24T09:00:00.000Z','2026-07-31T09:00:00.000Z','2026-10-30T09:00:00.000Z']);
    const until=makeApp(WEEKDAY_SETPOS+';UNTIL=20260215T000000Z');
    expect(starts(await oneShot(until,'2026-01-01T00:00:00Z','2027-01-01T00:00:00Z')))
      .toEqual(['2026-01-01T09:00:00.000Z','2026-01-30T09:00:00.000Z','2026-02-02T09:00:00.000Z']);
    const count=makeApp(WEEKDAY_SETPOS+';COUNT=5');
    const start='2026-01-01T00:00:00Z',end='2027-01-01T00:00:00Z';
    const expected=starts(await oneShot(count,start,end));
    expect(expected).toEqual(['2026-01-01T09:00:00.000Z','2026-01-30T09:00:00.000Z','2026-02-02T09:00:00.000Z','2026-02-27T09:00:00.000Z','2026-03-02T09:00:00.000Z']);
    const {items}=await paged(count,start,end,2);
    expect(starts(items)).toEqual(expected);
  });

  it('reads a window in reverse, page by page',async()=>{
    const app=makeApp('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31');
    const start='2026-01-01T00:00:00Z',end='2027-01-01T00:00:00Z';
    const {items,pages}=await paged(app,start,end,2,'desc');
    expect(pages).toBe(4);
    expect(starts(items)).toEqual(['2026-12-31T09:00:00.000Z','2026-10-31T09:00:00.000Z','2026-08-31T09:00:00.000Z','2026-07-31T09:00:00.000Z','2026-05-31T09:00:00.000Z','2026-03-31T09:00:00.000Z','2026-01-31T09:00:00.000Z']);
  });

  it('anchors the cursor on the period boundary and the occurrence identity, not a bare timestamp',async()=>{
    const app=makeApp(WEEKDAY_SETPOS);
    const first=await request(app).get('/api/schedules/r1/occurrences')
      .query({start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z',limit:1}).expect(200);
    const cursor=JSON.parse(Buffer.from(first.body.nextCursor,'base64url').toString('utf8'));
    expect(cursor).toMatchObject({v:1,rev:1,dir:'asc',period:'2026-01-01T00:00:00.000Z',last:'2026-01-01T09:00:00.000Z'});
    expect(cursor.period).not.toBe(cursor.last); // period boundary, not just a timestamp
    expect(cursor.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects a cursor after the rule changed (409)',async()=>{
    const app=makeApp(WEEKDAY_SETPOS);
    const first=await request(app).get('/api/schedules/r1/occurrences')
      .query({start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z',limit:2}).expect(200);
    const before=await request(app).get('/api/schedules/r1').expect(200);
    await request(app).put('/api/schedules/r1').send({content:WEEKDAY_SETPOS+';INTERVAL=2',revision:before.body.revision}).expect(200);
    await request(app).get('/api/schedules/r1/occurrences').query({cursor:first.body.nextCursor,limit:2})
      .expect(409)
      .expect(res=>expect(res.body.error).toBe('rule_changed'));
  });

  it('rejects mismatched windows, bad cursors, bad windows and invalid rules',async()=>{
    const app=makeApp(WEEKDAY_SETPOS);
    const first=await request(app).get('/api/schedules/r1/occurrences')
      .query({start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z',limit:2}).expect(200);
    await request(app).get('/api/schedules/r1/occurrences')
      .query({cursor:first.body.nextCursor,limit:2,start:'2026-02-01T00:00:00Z'}).expect(400)
      .expect(res=>expect(res.body.error).toBe('cursor_mismatch'));
    await request(app).get('/api/schedules/r1/occurrences').query({cursor:'!!!not-a-cursor'}).expect(400)
      .expect(res=>expect(res.body.error).toBe('bad_cursor'));
    await request(app).get('/api/schedules/r1/occurrences').query({start:'2027-01-01T00:00:00Z',end:'2026-01-01T00:00:00Z'}).expect(400)
      .expect(res=>expect(res.body.error).toBe('bad_window'));
    await request(app).get('/api/schedules/nope/occurrences').query({start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z'}).expect(404);
    const broken=makeApp('not a rule at all');
    await request(broken).get('/api/schedules/r1/occurrences').query({start:'2026-01-01T00:00:00Z',end:'2027-01-01T00:00:00Z'}).expect(400)
      .expect(res=>{expect(res.body.error).toBe('invalid_rule');expect(res.body.diagnostics.length).toBeGreaterThan(0)});
  });
});
