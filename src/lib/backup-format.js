/**
 * Human-friendly formatting for backup listings.
 *
 * Backup filenames embed the canonical backup time as `_YYYYMMDD_HHMMSS_`
 * (e.g. `myproject_20260519_120001_full.tar.gz`). Both `restore` (the picker)
 * and `backup list` parse that and render a relative, scannable label —
 * "Today, 12:00 PM" — instead of the raw S3 key.
 */

const TS_RE = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse the embedded backup timestamp from a backup filename.
 * @param {string} name
 * @returns {Date|null} local-time Date, or null if no timestamp is present
 */
export function parseBackupTime(name) {
  const m = typeof name === 'string' ? name.match(TS_RE) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clockTime(date) {
  const h24 = date.getHours();
  const m = date.getMinutes();
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Render a relative, human-readable label for a backup filename:
 * "Today, 12:00 PM" / "Yesterday, 6:00 PM" / "May 17, 12:00 PM" /
 * "Dec 31 2025, 6:00 PM" (older year). Falls back to the raw name if the
 * timestamp can't be parsed.
 *
 * @param {string} name
 * @param {Date} [now] - injectable for testing; defaults to the current time
 * @returns {string}
 */
/**
 * Render a Date as a relative, human-readable label.
 * "Today, 12:00 PM" / "Yesterday, 6:00 PM" / "May 17, 12:00 PM" /
 * "Dec 31 2025, 6:00 PM" (older year).
 * @param {Date} date
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDate(date, now = new Date()) {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  let day;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Yesterday';
  else if (date.getFullYear() === now.getFullYear())
    day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  else day = `${MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;

  return `${day}, ${clockTime(date)}`;
}

export function formatBackupTime(name, now = new Date()) {
  const date = parseBackupTime(name);
  if (!date) return name;
  return formatDate(date, now);
}

/**
 * Render an instant (Date or ISO-8601 string, e.g. wal-g's `time` field) using
 * the same relative labels as formatBackupTime. Returns '' for unparseable input.
 * @param {Date|string} value
 * @param {Date} [now]
 * @returns {string}
 */
export function formatInstant(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatDate(date, now);
}
