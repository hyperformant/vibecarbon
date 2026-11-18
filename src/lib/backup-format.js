/**
 * Human-friendly formatting for backup listings: the restore picker renders
 * a backup's time as a relative, scannable label ("Today, 12:00 PM").
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
 * Render a Date as a relative, human-readable label.
 * "Today, 12:00 PM" / "Yesterday, 6:00 PM" / "May 17, 12:00 PM" /
 * "Dec 31 2025, 6:00 PM" (older year).
 * @param {Date} date
 * @param {Date} [now]
 * @returns {string}
 */
function formatDate(date, now = new Date()) {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  let day;
  if (dayDiff === 0) day = 'Today';
  else if (dayDiff === 1) day = 'Yesterday';
  else if (date.getFullYear() === now.getFullYear())
    day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  else day = `${MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;

  return `${day}, ${clockTime(date)}`;
}

/**
 * Render an instant (Date or ISO-8601 string, e.g. wal-g's `time` field) using
 * formatDate's relative labels. Returns '' for unparseable input.
 * @param {Date|string} value
 * @param {Date} [now]
 * @returns {string}
 */
export function formatInstant(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatDate(date, now);
}
