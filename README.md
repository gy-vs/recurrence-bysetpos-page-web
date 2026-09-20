# Recurrence Rule Studio

Local workbench for occurrence sets.

Run `npm install`, then `npm run dev`.

## Rule format

Schedule content is a small iCalendar-style rule (UTC only):

```
DTSTART:20260101T090000Z
RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1
```

Supported: `FREQ` (DAILY/WEEKLY/MONTHLY/YEARLY), `INTERVAL`, `BYDAY`,
`BYMONTHDAY`, `BYMONTH`, `BYSETPOS`, `WKST`, `UNTIL`, `COUNT`.

## Occurrence preview

`GET /api/schedules/:id/occurrences?start=&end=&dir=&limit=&cursor=`

Expansion is period-first: candidates are generated for the full frequency
period, `BYSETPOS` is applied against that complete period, and only then is
the result intersected with the requested `[start, end)` window (start
inclusive, end exclusive).

Pagination cursors are opaque and pin the rule revision, a content hash, the
window, the direction, the containing period boundary and the identity of the
last emitted occurrence — never a bare timestamp. Continuing with a cursor
after the rule changed yields `409 rule_changed`; a mismatched window or
direction yields `400 cursor_mismatch`. For a fixed rule revision,
concatenating all pages in either direction is identical to a one-shot
expansion of the same window.

The client merges pages by occurrence identity (`period#start`): exact
duplicates at page seams are dropped, but items are never re-sorted or
interpolated, and non-monotonic arrivals surface as merge warnings rather
than being silently repaired.
