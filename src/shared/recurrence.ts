export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type WeekdayCode = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';
export type PageDirection = 'forward' | 'backward';

export interface ByDayToken {
  readonly weekday: WeekdayCode;
  readonly ordinal?: number;
}

export interface RecurrenceRule {
  readonly revision: string;
  readonly dtstart: Date;
  readonly allDay: boolean;
  readonly frequency: Frequency;
  readonly interval: number;
  readonly wkst: WeekdayCode;
  readonly byday: readonly ByDayToken[];
  readonly bymonthday: readonly number[];
  readonly bysetpos: readonly number[];
}

export interface Occurrence {
  readonly id: string;
  readonly startAt: string;
  readonly periodStart: string;
  readonly indexInPeriod: number;
}

export interface PageBoundary {
  readonly periodStart: string;
  readonly occurrenceId: string;
}

export interface OccurrencePage {
  readonly revision: string;
  readonly from: string;
  readonly to: string;
  readonly limit: number | null;
  readonly direction: PageDirection;
  readonly occurrences: readonly Occurrence[];
  readonly nextCursor: string | null;
  readonly pageInfo: {
    readonly hasMore: boolean;
    readonly boundary: PageBoundary | null;
  };
}

export class RecurrenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

const DAY_MS = 86_400_000;
const WEEKDAYS: readonly WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_LIMIT = 200;
const MAX_WINDOW_MS = 10 * 366 * DAY_MS;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function compactDate(value: Date): string {
  return `${value.getUTCFullYear()}${pad2(value.getUTCMonth() + 1)}${pad2(value.getUTCDate())}`;
}

function compactDateTime(value: Date): string {
  return `${compactDate(value)}T${pad2(value.getUTCHours())}${pad2(value.getUTCMinutes())}${pad2(value.getUTCSeconds())}Z`;
}

function parseICalDate(value: string, allDay: boolean): Date {
  const match = allDay
    ? /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) {
    throw new RecurrenceError(400, `Invalid DTSTART value: ${value}`);
  }
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const result = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  if (
    result.getUTCFullYear() !== Number(year) ||
    result.getUTCMonth() !== Number(month) - 1 ||
    result.getUTCDate() !== Number(day)
  ) {
    throw new RecurrenceError(400, `Invalid DTSTART value: ${value}`);
  }
  return result;
}

export function parseInstant(value: string | Date): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RecurrenceError(400, 'Invalid instant');
    return new Date(value.getTime());
  }
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) return parseICalDate(text, true);
  if (/^\d{8}T\d{6}Z$/.test(text)) return parseICalDate(text, false);
  const result = new Date(text);
  if (Number.isNaN(result.getTime())) {
    throw new RecurrenceError(400, `Invalid instant: ${value}`);
  }
  return result;
}

function hashRevision(value: string): string {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x0100_0193);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x85eb_ca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2_ae35);
  hash ^= hash >>> 16;
  return `r${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function splitList(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}

function parseInteger(value: string, label: string): number {
  if (!/^[+-]?\d+$/.test(value)) {
    throw new RecurrenceError(400, `${label} must be an integer`);
  }
  return Number(value);
}

function canonicalByday(byday: readonly ByDayToken[]): string {
  return [...byday]
    .sort((a, b) => {
      const weekday = WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday);
      return weekday || (a.ordinal ?? 0) - (b.ordinal ?? 0);
    })
    .map(token => `${token.ordinal ?? ''}${token.weekday}`)
    .join(',');
}

export function parseRule(ruleText: string, explicitRevision?: string | number): RecurrenceRule {
  const lines = ruleText
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const dtstartLine = lines.find(line => /^DTSTART(?:[;:]|$)/i.test(line));
  if (!dtstartLine) throw new RecurrenceError(400, 'DTSTART is required');
  if (/^DTSTART;/i.test(dtstartLine)) {
    throw new RecurrenceError(400, 'Only UTC or all-day DTSTART values are supported');
  }
  const dtstartValue = dtstartLine.slice(dtstartLine.indexOf(':') + 1);
  const allDay = /^\d{8}$/.test(dtstartValue);
  const dtstart = parseICalDate(dtstartValue, allDay);

  const rruleLine = lines.find(line => /^RRULE:/i.test(line));
  if (!rruleLine) throw new RecurrenceError(400, 'RRULE is required');

  const properties = new Map<string, string>();
  for (const part of rruleLine.slice('RRULE:'.length).split(';')) {
    if (!part) continue;
    const equals = part.indexOf('=');
    if (equals < 0) throw new RecurrenceError(400, `Invalid RRULE part: ${part}`);
    const name = part.slice(0, equals).toUpperCase();
    const value = part.slice(equals + 1).toUpperCase();
    if (properties.has(name)) throw new RecurrenceError(400, `Duplicate RRULE part: ${name}`);
    properties.set(name, value);
  }

  const frequency = properties.get('FREQ') as Frequency | undefined;
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY' && frequency !== 'MONTHLY') {
    throw new RecurrenceError(400, 'FREQ must be DAILY, WEEKLY, or MONTHLY');
  }

  const interval = properties.has('INTERVAL')
    ? parseInteger(properties.get('INTERVAL')!, 'INTERVAL')
    : 1;
  if (interval < 1 || interval > 1000) {
    throw new RecurrenceError(400, 'INTERVAL must be between 1 and 1000');
  }

  const wkst = (properties.get('WKST') ?? 'MO') as WeekdayCode;
  if (!WEEKDAYS.includes(wkst)) throw new RecurrenceError(400, 'Invalid WKST');

  let byday: ByDayToken[] = [];
  if (properties.has('BYDAY')) {
    const seen = new Set<string>();
    for (const item of splitList(properties.get('BYDAY')!)) {
      const match = /^([+-]?[1-9]\d*)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item);
      if (!match) throw new RecurrenceError(400, `Invalid BYDAY value: ${item}`);
      const ordinal = match[1] === undefined ? undefined : Number(match[1]);
      if (ordinal !== undefined && frequency !== 'MONTHLY') {
        throw new RecurrenceError(400, 'Ordinal BYDAY is supported only with FREQ=MONTHLY');
      }
      if (ordinal !== undefined && Math.abs(ordinal) > 5) {
        throw new RecurrenceError(400, 'Monthly BYDAY ordinal must be between -5 and 5');
      }
      const token: ByDayToken = {weekday: match[2] as WeekdayCode, ordinal};
      const key = `${token.ordinal ?? ''}${token.weekday}`;
      if (!seen.has(key)) {
        seen.add(key);
        byday.push(token);
      }
    }
  }

  let bymonthday: number[] = [];
  if (properties.has('BYMONTHDAY')) {
    if (frequency !== 'MONTHLY') {
      throw new RecurrenceError(400, 'BYMONTHDAY is supported only with FREQ=MONTHLY');
    }
    bymonthday = splitList(properties.get('BYMONTHDAY')!).map(item => {
      const value = parseInteger(item, 'BYMONTHDAY');
      if (value === 0 || value < -31 || value > 31) {
        throw new RecurrenceError(400, 'BYMONTHDAY must be between -31 and 31 and non-zero');
      }
      return value;
    });
    bymonthday = [...new Set(bymonthday)].sort((a, b) => a - b);
  }

  let bysetpos: number[] = [];
  if (properties.has('BYSETPOS')) {
    const maximum = frequency === 'MONTHLY' ? 31 : frequency === 'WEEKLY' ? 7 : 1;
    bysetpos = splitList(properties.get('BYSETPOS')!).map(item => {
      const value = parseInteger(item, 'BYSETPOS');
      if (value === 0 || Math.abs(value) > maximum) {
        throw new RecurrenceError(400, `BYSETPOS must be between -${maximum} and ${maximum} and non-zero`);
      }
      return value;
    });
    bysetpos = [...new Set(bysetpos)].sort((a, b) => a - b);
  }

  for (const name of properties.keys()) {
    if (!['FREQ', 'INTERVAL', 'WKST', 'BYDAY', 'BYMONTHDAY', 'BYSETPOS'].includes(name)) {
      throw new RecurrenceError(400, `Unsupported RRULE part: ${name}`);
    }
  }

  if (frequency === 'MONTHLY' && byday.length === 0 && bymonthday.length === 0) {
    bymonthday = [dtstart.getUTCDate()];
  }
  if (frequency === 'WEEKLY' && byday.length === 0) {
    byday = [{weekday: WEEKDAYS[dtstart.getUTCDay()]}];
  }
  byday.sort((a, b) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday));

  const canonical = [
    `DTSTART=${allDay ? compactDate(dtstart) : compactDateTime(dtstart)}`,
    `FREQ=${frequency}`,
    `INTERVAL=${interval}`,
    `WKST=${wkst}`,
    byday.length ? `BYDAY=${canonicalByday(byday)}` : '',
    bymonthday.length ? `BYMONTHDAY=${bymonthday.join(',')}` : '',
    bysetpos.length ? `BYSETPOS=${bysetpos.join(',')}` : '',
  ].filter(Boolean).join('\n');
  const revision = explicitRevision === undefined ? hashRevision(canonical) : String(explicitRevision);

  return {
    revision,
    dtstart,
    allDay,
    frequency,
    interval,
    wkst,
    byday,
    bymonthday,
    bysetpos,
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function startOfPeriod(value: Date, rule: Pick<RecurrenceRule, 'frequency' | 'wkst'>): Date {
  const day = startOfUtcDay(value);
  if (rule.frequency === 'MONTHLY') {
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  }
  if (rule.frequency === 'DAILY') return day;
  const weekday = day.getUTCDay();
  const wkstIndex = WEEKDAYS.indexOf(rule.wkst);
  const offset = (weekday - wkstIndex + 7) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

function addPeriod(start: Date, frequency: Frequency, count: number, wkst: WeekdayCode): Date {
  if (frequency === 'MONTHLY') {
    const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + count;
    return new Date(Date.UTC(Math.floor(total / 12), ((total % 12) + 12) % 12, 1));
  }
  const unit = frequency === 'WEEKLY' ? 7 * DAY_MS : DAY_MS;
  return new Date(start.getTime() + count * unit);
}

function periodDistance(first: Date, second: Date, frequency: Frequency): number {
  if (frequency === 'MONTHLY') {
    return (second.getUTCFullYear() - first.getUTCFullYear()) * 12
      + second.getUTCMonth() - first.getUTCMonth();
  }
  const unit = frequency === 'WEEKLY' ? 7 * DAY_MS : DAY_MS;
  return Math.round((second.getTime() - first.getTime()) / unit);
}

function timeOfDay(value: Date): number {
  return value.getTime() - startOfUtcDay(value).getTime();
}

function ordinalWeekdayDay(year: number, month: number, weekday: number, ordinal: number): number | null {
  if (ordinal > 0) {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    const day = 1 + offset + (ordinal - 1) * 7;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return day <= daysInMonth ? day : null;
  }
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, daysInMonth));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  const day = daysInMonth - offset + (ordinal + 1) * 7;
  return day >= 1 ? day : null;
}

function rawPeriodCandidates(rule: RecurrenceRule, periodStart: Date): readonly Date[] {
  const time = timeOfDay(rule.dtstart);
  let timestamps: number[] = [];

  if (rule.frequency === 'MONTHLY') {
    const year = periodStart.getUTCFullYear();
    const month = periodStart.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    let days: number[];
    if (rule.bymonthday.length) {
      days = rule.bymonthday
        .map(value => (value > 0 ? value : daysInMonth + value + 1))
        .filter(day => day >= 1 && day <= daysInMonth);
    } else {
      days = Array.from({length: daysInMonth}, (_unused, index) => index + 1);
    }

    if (rule.byday.length) {
      days = days.filter(day => {
        const date = new Date(Date.UTC(year, month, day));
        return rule.byday.some(token => {
          if (token.ordinal === undefined) return token.weekday === WEEKDAYS[date.getUTCDay()];
          const ordinalDay = ordinalWeekdayDay(
            year,
            month,
            WEEKDAYS.indexOf(token.weekday),
            token.ordinal,
          );
          return ordinalDay === day;
        });
      });
    }
    timestamps = days.map(day => Date.UTC(year, month, day) + time);
  } else if (rule.frequency === 'WEEKLY') {
    const wkstIndex = WEEKDAYS.indexOf(rule.wkst);
    for (let offset = 0; offset < 7; offset += 1) {
      const weekday = WEEKDAYS[(wkstIndex + offset) % 7];
      if (rule.byday.some(token => token.weekday === weekday)) {
        timestamps.push(periodStart.getTime() + offset * DAY_MS + time);
      }
    }
  } else {
    if (
      rule.byday.length === 0
      || rule.byday.some(token => token.weekday === WEEKDAYS[periodStart.getUTCDay()])
    ) {
      timestamps.push(periodStart.getTime() + time);
    }
  }

  return [...new Set(timestamps)]
    .sort((a, b) => a - b)
    .filter(timestamp => timestamp >= rule.dtstart.getTime())
    .map(timestamp => new Date(timestamp));
}

export function expandPeriod(rule: RecurrenceRule, periodStart: Date): readonly Occurrence[] {
  const candidates = rawPeriodCandidates(rule, periodStart);
  const selected = new Set<Date>();

  if (rule.bysetpos.length === 0) {
    candidates.forEach(candidate => selected.add(candidate));
  } else {
    for (const position of rule.bysetpos) {
      const index = position > 0 ? position - 1 : candidates.length + position;
      const candidate = candidates[index];
      if (candidate) selected.add(candidate);
    }
  }

  return [...selected]
    .sort((a, b) => a.getTime() - b.getTime())
    .map((occurrence, index) => ({
      id: `${compactDate(periodStart)}-${index + 1}`,
      startAt: occurrence.toISOString(),
      periodStart: periodStart.toISOString(),
      indexInPeriod: index + 1,
    }));
}

interface PeriodWindow {
  start: Date;
  end: Date;
}

function* periodIterator(
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  direction: PageDirection,
  resumePeriod?: Date,
): Generator<PeriodWindow> {
  const anchor = startOfPeriod(rule.dtstart, rule);
  let periodIndex: number;

  if (resumePeriod) {
    const expected = startOfPeriod(resumePeriod, rule);
    if (expected.getTime() !== resumePeriod.getTime()) {
      throw new RecurrenceError(400, 'Cursor period boundary is misaligned');
    }
    periodIndex = periodDistance(anchor, resumePeriod, rule.frequency);
    if (periodIndex < 0 || periodIndex % rule.interval !== 0) {
      throw new RecurrenceError(400, 'Cursor period boundary is outside this rule');
    }
  } else {
    const edge = startOfPeriod(direction === 'forward' ? from : to, rule);
    const distance = periodDistance(anchor, edge, rule.frequency);
    periodIndex = Math.floor(distance / rule.interval) * rule.interval;
    if (periodIndex < 0) periodIndex = 0;
  }

  while (true) {
    const start = addPeriod(anchor, rule.frequency, periodIndex, rule.wkst);
    const end = addPeriod(start, rule.frequency, 1, rule.wkst);
    if (start.getTime() <= to.getTime() && end.getTime() > from.getTime()) {
      yield {start, end};
    }

    if (direction === 'forward') {
      const nextIndex = periodIndex + rule.interval;
      const nextStart = addPeriod(anchor, rule.frequency, nextIndex, rule.wkst);
      if (nextStart.getTime() > to.getTime()) return;
      periodIndex = nextIndex;
    } else {
      const nextIndex = periodIndex - rule.interval;
      if (nextIndex < 0) return;
      const nextStart = addPeriod(anchor, rule.frequency, nextIndex, rule.wkst);
      const nextEnd = addPeriod(nextStart, rule.frequency, 1, rule.wkst);
      if (nextEnd.getTime() <= from.getTime()) return;
      periodIndex = nextIndex;
    }
  }
}

function inWindow(occurrence: Occurrence, from: Date, to: Date): boolean {
  const time = Date.parse(occurrence.startAt);
  return time >= from.getTime() && time <= to.getTime();
}

function validateWindow(from: Date, to: Date): void {
  if (from.getTime() > to.getTime()) {
    throw new RecurrenceError(400, '`from` must not be after `to`');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new RecurrenceError(400, 'Expansion window is too large');
  }
}

export function expandRule(
  rule: RecurrenceRule,
  window: {from: string | Date; to: string | Date},
): Occurrence[] {
  const from = parseInstant(window.from);
  const to = parseInstant(window.to);
  validateWindow(from, to);

  const occurrences: Occurrence[] = [];
  for (const period of periodIterator(rule, from, to, 'forward')) {
    for (const occurrence of expandPeriod(rule, period.start)) {
      if (inWindow(occurrence, from, to)) occurrences.push(occurrence);
    }
  }
  return occurrences;
}

interface CursorData {
  version: 1;
  revision: string;
  from: string;
  to: string;
  limit: number;
  direction: PageDirection;
  periodStart: string;
  lastOccurrenceId: string;
}

export function encodeCursor(cursor: Omit<CursorData, 'version'>): string {
  const data: CursorData = {...cursor, version: 1};
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  const base64 = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `occ1.${base64}`;
}

export function decodeCursor(value: string): CursorData {
  const parts = /^occ1\.(.+)$/.exec(value);
  if (!parts) throw new RecurrenceError(400, 'Invalid occurrence cursor');
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes)) as CursorData;
    if (
      data.version !== 1 ||
      typeof data.revision !== 'string' ||
      typeof data.from !== 'string' ||
      typeof data.to !== 'string' ||
      typeof data.limit !== 'number' ||
      (data.direction !== 'forward' && data.direction !== 'backward') ||
      typeof data.periodStart !== 'string' ||
      typeof data.lastOccurrenceId !== 'string'
    ) {
      throw new Error('bad shape');
    }
    return data;
  } catch {
    throw new RecurrenceError(400, 'Invalid occurrence cursor');
  }
}

export interface PageQuery {
  from: string | Date;
  to: string | Date;
  limit: number;
  direction?: PageDirection;
  cursor?: string | null;
}

function* visibleOccurrences(
  rule: RecurrenceRule,
  from: Date,
  to: Date,
  direction: PageDirection,
  cursor: CursorData | null,
): Generator<Occurrence> {
  const resumePeriod = cursor ? parseInstant(cursor.periodStart) : undefined;
  for (const period of periodIterator(rule, from, to, direction, resumePeriod)) {
    let occurrences = expandPeriod(rule, period.start).filter(item => inWindow(item, from, to));
    if (direction === 'backward') occurrences = [...occurrences].reverse();

    if (cursor && period.start.getTime() === resumePeriod!.getTime()) {
      let foundResume = false;
      for (const occurrence of occurrences) {
        if (!foundResume) {
          if (occurrence.id === cursor.lastOccurrenceId) {
            foundResume = true;
            yield occurrence;
          }
          continue;
        }
        yield occurrence;
      }
      if (!foundResume) {
        throw new RecurrenceError(400, 'Cursor occurrence identity is missing from its period');
      }
    } else {
      yield* occurrences;
    }
  }
}

export function expandPage(rule: RecurrenceRule, query: PageQuery): OccurrencePage {
  const from = parseInstant(query.from);
  const to = parseInstant(query.to);
  validateWindow(from, to);
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
    throw new RecurrenceError(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const direction: PageDirection = query.direction ?? 'forward';
  if (direction !== 'forward' && direction !== 'backward') {
    throw new RecurrenceError(400, 'direction must be forward or backward');
  }

  let cursor: CursorData | null = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
    if (cursor.revision !== rule.revision) {
      throw new RecurrenceError(409, 'Cursor was created for a different rule revision');
    }
    if (
      cursor.from !== from.toISOString()
      || cursor.to !== to.toISOString()
      || cursor.limit !== query.limit
      || cursor.direction !== direction
    ) {
      throw new RecurrenceError(400, 'Cursor does not match this expansion query');
    }
  }

  const generator = visibleOccurrences(rule, from, to, direction, cursor);
  const occurrences: Occurrence[] = [];
  for (let index = 0; index < query.limit; index += 1) {
    const next = generator.next();
    if (next.done) break;
    occurrences.push(next.value);
  }

  const hasMore = !generator.next().done;
  const last = occurrences[occurrences.length - 1];
  const boundary: PageBoundary | null = last
    ? {periodStart: last.periodStart, occurrenceId: last.id}
    : null;

  return {
    revision: rule.revision,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: query.limit,
    direction,
    occurrences,
    nextCursor: hasMore && last
      ? encodeCursor({
        revision: rule.revision,
        from: from.toISOString(),
        to: to.toISOString(),
        limit: query.limit,
        direction,
        periodStart: last.periodStart,
        lastOccurrenceId: last.id,
      })
      : null,
    pageInfo: {hasMore, boundary},
  };
}

export function oneShotPage(
  rule: RecurrenceRule,
  window: {from: string | Date; to: string | Date},
): OccurrencePage {
  const from = parseInstant(window.from);
  const to = parseInstant(window.to);
  return {
    revision: rule.revision,
    from: from.toISOString(),
    to: to.toISOString(),
    limit: null,
    direction: 'forward',
    occurrences: expandRule(rule, window),
    nextCursor: null,
    pageInfo: {hasMore: false, boundary: null},
  };
}

function sameOccurrence(left: Occurrence, right: Occurrence): boolean {
  return left.id === right.id
    && left.startAt === right.startAt
    && left.periodStart === right.periodStart
    && left.indexInPeriod === right.indexInPeriod;
}

export function mergeOccurrencePages(pages: readonly OccurrencePage[]): Occurrence[] {
  if (pages.length === 0) return [];
  const first = pages[0];
  const merged: Occurrence[] = [];
  const seen = new Map<string, Occurrence>();

  pages.forEach((page, pageIndex) => {
    if (
      page.revision !== first.revision
      || page.from !== first.from
      || page.to !== first.to
      || page.direction !== first.direction
      || page.limit !== first.limit
    ) {
      throw new Error('Cannot merge pages from different occurrence queries or rule revisions');
    }
    if (pageIndex > 0) {
      const previous = pages[pageIndex - 1];
      const expected = previous.pageInfo.boundary;
      if (!previous.pageInfo.hasMore || !previous.nextCursor || !expected) {
        throw new Error('Cannot append a page after a terminal occurrence page');
      }
      const seam = page.occurrences[0];
      if (!seam || seam.id !== expected.occurrenceId || seam.periodStart !== expected.periodStart) {
        throw new Error('Page boundary identity is missing; refusing to hide skipped occurrences');
      }
    }

    page.occurrences.forEach((occurrence, occurrenceIndex) => {
      const existing = seen.get(occurrence.id);
      if (existing) {
        const isExpectedSeam = pageIndex > 0
          && occurrenceIndex === 0
          && occurrence.id === pages[pageIndex - 1].pageInfo.boundary?.occurrenceId;
        if (!isExpectedSeam || !sameOccurrence(existing, occurrence)) {
          throw new Error('Unexpected duplicate occurrence while merging pages');
        }
        return;
      }

      if (merged.length > 0) {
        const previousTime = Date.parse(merged[merged.length - 1].startAt);
        const currentTime = Date.parse(occurrence.startAt);
        if (page.direction === 'forward' ? currentTime <= previousTime : currentTime >= previousTime) {
          throw new Error('Occurrence pages are not contiguous in the requested direction');
        }
      }
      seen.set(occurrence.id, occurrence);
      merged.push(occurrence);
    });
  });

  return merged;
}
