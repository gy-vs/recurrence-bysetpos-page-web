import {describe,expect,it} from 'vitest';
import {applyBysetpos,expandWindow,occurrencesInPeriod,parseRule,periodStartOf} from '../src/server/recurrence';

const RULE_TEXT='DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1';
const iso=(s:string)=>new Date(s);
const starts=(list:{start:Date}[])=>list.map(o=>o.start.toISOString());

describe('parseRule',()=>{
  it('parses a monthly BYDAY/BYSETPOS rule',()=>{
    const {rule,diagnostics}=parseRule(RULE_TEXT);
    expect(diagnostics).toEqual([]);
    expect(rule).toMatchObject({freq:'MONTHLY',interval:1,bysetpos:[1,-1],wkst:'MO'});
    expect(rule!.byday).toEqual(['MO','TU','WE','TH','FR']);
    expect(rule!.dtstart.toISOString()).toBe('2026-01-01T09:00:00.000Z');
  });
  it('rejects ordinal BYDAY and points at BYSETPOS',()=>{
    const {rule,diagnostics}=parseRule('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=-1FR');
    expect(rule).toBeNull();
    expect(diagnostics.some(d=>d.level==='error'&&d.message.includes('BYSETPOS'))).toBe(true);
  });
  it('rejects BYSETPOS=0 and missing RRULE',()=>{
    expect(parseRule('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYSETPOS=0').rule).toBeNull();
    const {rule,diagnostics}=parseRule('DTSTART:20260101T090000Z');
    expect(rule).toBeNull();
    expect(diagnostics.some(d=>d.message.includes('missing RRULE'))).toBe(true);
  });
  it('warns on unknown parts without failing',()=>{
    const {rule,diagnostics}=parseRule(RULE_TEXT+';X_CUSTOM=1');
    expect(rule).not.toBeNull();
    expect(diagnostics.some(d=>d.level==='warning'&&d.message.includes('X_CUSTOM'))).toBe(true);
  });
});

describe('applyBysetpos',()=>{
  const c=[iso('2026-01-01T09:00Z'),iso('2026-01-02T09:00Z'),iso('2026-01-03T09:00Z')];
  it('selects positive and negative positions from the period ends',()=>{
    expect(applyBysetpos(c,[1])).toEqual([c[0]]);
    expect(applyBysetpos(c,[-1])).toEqual([c[2]]);
    expect(applyBysetpos(c,[1,-1])).toEqual([c[0],c[2]]);
    expect(applyBysetpos(c,[-2])).toEqual([c[1]]);
  });
  it('ignores out-of-range positions and dedupes',()=>{
    expect(applyBysetpos(c,[4,-4])).toEqual([]);
    expect(applyBysetpos(c,[1,1,-3])).toEqual([c[0]]);
  });
});

describe('periodStartOf',()=>{
  const base={freq:'WEEKLY',interval:1,byday:null,bymonthday:null,bymonth:null,bysetpos:null,dtstart:iso('2026-01-05T09:00:00Z'),until:null,count:null} as const;
  it('aligns weekly periods to WKST',()=>{
    expect(periodStartOf({...base,wkst:'MO'},iso('2026-01-07T12:00:00Z')).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(periodStartOf({...base,wkst:'SU'},iso('2026-01-07T12:00:00Z')).toISOString()).toBe('2026-01-04T00:00:00.000Z');
  });
  it('aligns monthly periods to DTSTART with INTERVAL',()=>{
    const rule={...base,freq:'MONTHLY' as const,interval:3,wkst:'MO' as const};
    expect(periodStartOf(rule,iso('2026-05-10T00:00:00Z')).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(periodStartOf(rule,iso('2026-03-31T23:00:00Z')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('occurrencesInPeriod',()=>{
  const rule=parseRule(RULE_TEXT).rule!;
  it('applies BYSETPOS to the full period candidate set',()=>{
    // January 2026 weekdays: Jan 1 is the first, Jan 30 the last.
    expect(occurrencesInPeriod(rule,iso('2026-01-01T00:00:00Z'))).toEqual([iso('2026-01-01T09:00:00Z'),iso('2026-01-30T09:00:00Z')]);
    expect(occurrencesInPeriod(rule,iso('2026-02-01T00:00:00Z'))).toEqual([iso('2026-02-02T09:00:00Z'),iso('2026-02-27T09:00:00Z')]);
  });
  it('yields empty periods when no candidate matches',()=>{
    const r=parseRule('DTSTART:20260101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31').rule!;
    expect(occurrencesInPeriod(r,iso('2026-02-01T00:00:00Z'))).toEqual([]);
    expect(occurrencesInPeriod(r,iso('2026-01-01T00:00:00Z'))).toEqual([iso('2026-01-31T09:00:00Z')]);
  });
});

describe('expandWindow',()=>{
  const rule=parseRule(RULE_TEXT).rule!;
  it('intersects with the window only after BYSETPOS (mid-month window start)',()=>{
    // A clipped-then-positioned engine would invent 2026-01-15 as "first
    // weekday of the window"; the true first weekday of January is Jan 1,
    // which lies outside the window, so January contributes nothing.
    const occs=expandWindow(rule,iso('2026-01-15T00:00:00Z'),iso('2026-04-15T00:00:00Z'));
    expect(starts(occs)).toEqual(['2026-01-30T09:00:00.000Z','2026-02-02T09:00:00.000Z','2026-02-27T09:00:00.000Z','2026-03-02T09:00:00.000Z','2026-03-31T09:00:00.000Z','2026-04-01T09:00:00.000Z']);
  });
  it('includes an occurrence exactly at the window start and excludes one at the end',()=>{
    const occs=expandWindow(rule,iso('2026-02-02T09:00:00Z'),iso('2026-03-02T09:00:00Z'));
    expect(starts(occs)).toEqual(['2026-02-02T09:00:00.000Z','2026-02-27T09:00:00.000Z']);
  });
  it('carries the period boundary in every occurrence identity',()=>{
    const [first]=expandWindow(rule,iso('2026-01-01T00:00:00Z'),iso('2026-02-01T00:00:00Z'));
    expect(first.id).toBe('2026-01-01T00:00:00.000Z#2026-01-01T09:00:00.000Z');
    expect(first.period.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
