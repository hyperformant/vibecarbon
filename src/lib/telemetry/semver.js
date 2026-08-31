/**
 * True when `latest` is a strictly newer plain semver triple than `current`.
 * Malformed or prerelease versions return false — we never nag on bad data.
 *
 * @param {string} latest
 * @param {string} current
 * @returns {boolean}
 */
export function isNewerVersion(latest, current) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}
