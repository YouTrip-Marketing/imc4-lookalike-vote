/**
 * Singapore time, formatted by hand.
 *
 * Singapore is UTC+8 all year with no daylight saving, so a fixed offset is
 * exact. Doing it by hand rather than through Intl means every browser, including
 * in-app webviews with trimmed-down locale data, prints the same thing.
 */

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

interface Parts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

function sgtParts(instant: Date): Parts {
  const shifted = new Date(instant.getTime() + SGT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

function clock(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'am' : 'pm';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)}${suffix}`;
}

/** "Tue 3 Nov, 12:00pm SGT". Returns '' for a missing or unreadable value. */
export function formatSgtDateTime(iso: string | null): string {
  if (iso === null) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  return `${DAYS[p.weekday]} ${p.day} ${MONTHS[p.month]}, ${clock(p.hour, p.minute)} SGT`;
}

/** "3 Nov, 12:00pm". For chart labels, where the day name and zone would crowd the axis. */
export function formatSgtShort(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  return `${p.day} ${MONTHS[p.month]}, ${clock(p.hour, p.minute)}`;
}

/**
 * Chart axis labels, as short as they can be: "12pm", "9:30am", and the date
 * only where asked for ("4 Nov 12am"), which is at the start and at each new day.
 */
export function formatSgtAxis(iso: string, withDate: boolean): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  const suffix = p.hour < 12 ? 'am' : 'pm';
  const twelve = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const time = p.minute === 0 ? `${twelve}${suffix}` : `${twelve}:${pad(p.minute)}${suffix}`;
  return withDate ? `${p.day} ${MONTHS[p.month]} ${time}` : time;
}

/** "5 Nov": the Singapore day and month an instant falls on. Returns '' for a missing or unreadable value. */
export function formatSgtDayMonth(iso: string | null): string {
  if (iso === null) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  return `${p.day} ${MONTHS[p.month]}`;
}

/** The Singapore calendar day an instant falls on, as YYYY-MM-DD. */
export function sgtDay(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** "2026-11-03 12:00:00". For CSV, where a spreadsheet should read it as a date. */
export function formatSgtStamp(iso: string | null): string {
  if (iso === null) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  const p = sgtParts(instant);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Formats a plain calendar date (YYYY-MM-DD) as "Thu 5 Nov". No time zone involved. */
export function formatCalendarDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const [, year, month, day] = match;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(value.getTime())) return date;
  return `${DAYS[value.getUTCDay()]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
}

/** "Thu 12 Nov 2026" for 2026-11-12 (Revision 12 winner line). The input is a calendar date, not an instant. */
export function formatCalendarDateWithYear(date: string): string {
  const short = formatCalendarDate(date);
  return short === date ? date : `${short} ${date.slice(0, 4)}`;
}

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Saturday, 7 Nov" for 2026-11-07 (Revision 10 wording). The input is a calendar date, not an instant. */
export function formatLongCalendarDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const [, year, month, day] = match;
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(value.getTime())) return date;
  return `${LONG_DAYS[value.getUTCDay()]}, ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`;
}
