import {describe,expect,it} from 'vitest';
import {mergePages,OccurrenceItem} from '../src/client/merge';

const occ=(period:string,start:string):OccurrenceItem=>({id:`${period}#${start}`,period,start});
const ids=(list:OccurrenceItem[])=>list.map(o=>o.id);

const jan1=occ('2026-01-01T00:00:00.000Z','2026-01-01T09:00:00.000Z');
const jan30=occ('2026-01-01T00:00:00.000Z','2026-01-30T09:00:00.000Z');
const feb2=occ('2026-02-01T00:00:00.000Z','2026-02-02T09:00:00.000Z');
const feb27=occ('2026-02-01T00:00:00.000Z','2026-02-27T09:00:00.000Z');

describe('mergePages',()=>{
  it('appends ascending pages and dedupes overlap by identity',()=>{
    const first=mergePages([],[jan1,jan30],'asc');
    expect(first.warnings).toEqual([]);
    const second=mergePages(first.items,[jan30,feb2,feb27],'asc'); // jan30 re-sent at the seam
    expect(ids(second.items)).toEqual(ids([jan1,jan30,feb2,feb27]));
    expect(second.warnings).toEqual([]);
  });
  it('prepends descending pages',()=>{
    const first=mergePages([],[feb27,feb2],'desc');
    const second=mergePages(first.items,[jan30,jan1],'desc');
    expect(ids(second.items)).toEqual(ids([jan30,jan1,feb27,feb2]));
    expect(second.warnings).toEqual([]);
  });
  it('flags out-of-order arrivals instead of silently re-sorting them',()=>{
    const first=mergePages([],[jan1,jan30],'asc');
    const merged=mergePages(first.items,[feb27,feb2],'asc'); // server sent a scrambled page
    expect(merged.warnings).toContain('page_not_monotonic');
    expect(ids(merged.items)).toEqual(ids([jan1,jan30,feb27,feb2])); // kept as received, not repaired
  });
  it('flags a page that does not extend the sequence',()=>{
    const first=mergePages([],[jan30,feb2],'asc');
    const merged=mergePages(first.items,[jan1],'asc'); // older item arriving late
    expect(merged.warnings).toContain('page_does_not_extend_sequence');
  });
  it('never fabricates occurrences to fill a server-side gap',()=>{
    // The server skipped jan30 entirely. Dedupe cannot and must not mask
    // that: the merged list simply lacks the occurrence.
    const merged=mergePages([],[jan1,feb2],'asc');
    expect(ids(merged.items)).toEqual(ids([jan1,feb2]));
    expect(merged.items).toHaveLength(2);
  });
  it('drops duplicate identities inside a single page',()=>{
    const merged=mergePages([],[jan1,jan1,jan30],'asc');
    expect(ids(merged.items)).toEqual(ids([jan1,jan30]));
  });
});
