/**
 * The add-ons an e2e scenario deploys with.
 *
 * Every e2e run is a STOCK deploy: the app and its database, no add-ons at
 * all, not even observability (owner decision 2026-11-15). The baseline in
 * tests/config.ts is `[]`, and only a stock scenario may feed a published
 * number (docs/perf-data.json, the README table, the marketing data) or a
 * deploy budget. A run given `--features` deploys those add-ons on top: it is
 * recorded, its checks run, and nothing it measures is published or
 * calibrated.
 *
 * One module, because the runner (TypeScript), the perf publisher and the
 * budget calibrator (scripts/calibrate-deploy-budgets.js, plain Node) all
 * apply the same rule.
 */

/**
 * `--features=a,b` or `--features a,b` -> `['a', 'b']`. The flag present with
 * no value (`--features=`, or `--features` followed by another flag or by
 * nothing) -> `[]`. The flag absent -> `null`, so "not given" never reads as
 * "given, and empty".
 *
 * @param {readonly string[]} args - argv after the script name
 * @returns {string[] | null}
 */
export function parseFeaturesArg(args) {
  const split = (raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const eq = args.find((a) => a.startsWith('--features='));
  if (eq !== undefined) return split(eq.slice('--features='.length));
  const at = args.indexOf('--features');
  if (at === -1) return null;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? [] : split(value);
}

/**
 * The features every scenario of a run deploys with: the caller's option,
 * else the `--features` flag, else the baseline. `null` and `undefined` both
 * mean "not given" and fall through. The runner once asked
 * `override !== undefined` of a value parseFeaturesArg sets to `null`, so an
 * absent flag read as an override on every run.
 *
 * @param {readonly string[] | null | undefined} fromOptions
 * @param {readonly string[] | null | undefined} fromArgs
 * @param {readonly string[]} baseline
 * @returns {readonly string[]}
 */
export function resolveRunFeatures(fromOptions, fromArgs, baseline) {
  return fromOptions ?? fromArgs ?? baseline;
}

/**
 * Whether a feature list is stock: no add-ons.
 *
 * @param {readonly string[]} features
 * @returns {boolean}
 */
export function isStockFeatures(features) {
  return features.length === 0;
}

/**
 * Whether a `scenarios.features` value from an e2e results db records a stock
 * deploy: exactly a JSON empty list. NULL (a row written before the column
 * existed) and anything unreadable are not stock, because nothing proves
 * them so.
 *
 * @param {string | null | undefined} raw
 * @returns {boolean}
 */
export function isStockFeaturesRecord(raw) {
  if (typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * A `scenarios.features` value for a log line: the add-on names, or why
 * there are none to show.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function describeFeaturesRecord(raw) {
  if (typeof raw !== 'string') return 'features not recorded';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length === 0 ? 'none' : parsed.join(', ');
  } catch {
    // fall through
  }
  return `unreadable features ${JSON.stringify(raw.slice(0, 80))}`;
}
