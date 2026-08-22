import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock clack so spinner() returns a controllable fake (no real TTY writes).
// The wrapper reassigns start/stop in place, so keep raw* refs the wrapper can't
// shadow — that's what proves delegation to the underlying clack spinner.
const spinnerInstances: Array<{
  rawMessage: ReturnType<typeof vi.fn>;
  message: ReturnType<typeof vi.fn>;
  rawStart: ReturnType<typeof vi.fn>;
  rawStop: ReturnType<typeof vi.fn>;
  opts: unknown;
}> = [];
const clackLog = { info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn() };
vi.mock('@clack/prompts', () => ({
  spinner: (opts: unknown) => {
    const rawStart = vi.fn();
    const rawStop = vi.fn();
    // spinner() wraps .message in place (to clip width), so the spy must be a
    // separate ref the wrapper delegates to — same trick as rawStart/rawStop.
    const rawMessage = vi.fn();
    const inst = {
      start: rawStart,
      stop: rawStop,
      error: vi.fn(),
      cancel: vi.fn(),
      message: rawMessage,
      rawStart,
      rawStop,
      rawMessage,
      opts,
    };
    spinnerInstances.push(inst);
    return inst;
  },
  get log() {
    return clackLog;
  },
}));

import {
  clipToWidth,
  progressLog,
  shouldAnimateSpinner,
  spinner,
} from '../../../../src/lib/cli/progress.js';

// The env signals shouldAnimateSpinner() reads. The unit suite itself runs in
// CI (GITHUB_ACTIONS/CI set), so the spinner() integration tests that need the
// ANIMATE path must clear every signal, not just CI.
const CI_SIGNALS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'NO_COLOR',
  'VIBECARBON_PLAIN',
];
const origIsTTY = process.stdout.isTTY;
const origEnv: Record<string, string | undefined> = {};
for (const k of [...CI_SIGNALS, 'TERM']) origEnv[k] = process.env[k];

function forceAnimate() {
  process.stdout.isTTY = true;
  for (const k of CI_SIGNALS) delete process.env[k];
  process.env.TERM = 'xterm-256color';
}
function forceQuiet() {
  process.env.CI = 'true';
}
const TTY = { isTTY: true } as NodeJS.WriteStream;

afterEach(() => {
  spinnerInstances.length = 0;
  for (const m of [clackLog.info, clackLog.success, clackLog.error, clackLog.warn]) m.mockClear();
  process.stdout.isTTY = origIsTTY;
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('shouldAnimateSpinner', () => {
  // Pass an explicit env so these are independent of the runner's own CI vars.
  it('animates only on a TTY with no CI / plain / dumb signal', () => {
    expect(shouldAnimateSpinner(TTY, { TERM: 'xterm-256color' })).toBe(true);
  });
  it('does NOT animate off a TTY (cursor-erase is a no-op)', () => {
    expect(shouldAnimateSpinner({ isTTY: false } as NodeJS.WriteStream, {})).toBe(false);
    expect(shouldAnimateSpinner({} as NodeJS.WriteStream, {})).toBe(false);
  });
  it.each([
    ['CI', { CI: 'true' }],
    ['CI truthy non-true', { CI: '1' }],
    ['GITHUB_ACTIONS', { GITHUB_ACTIONS: 'true' }],
    ['CONTINUOUS_INTEGRATION', { CONTINUOUS_INTEGRATION: 'true' }],
    ['NO_COLOR', { NO_COLOR: '1' }],
    ['TERM=dumb', { TERM: 'dumb' }],
    ['VIBECARBON_PLAIN (escape hatch)', { VIBECARBON_PLAIN: '1' }],
  ])('does NOT animate when %s is set (even on a TTY)', (_label, env) => {
    expect(shouldAnimateSpinner(TTY, env as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('spinner under CI / non-TTY renders quiet start/stop (no frame spam)', () => {
  it('never constructs a clack spinner (which would frame-spam under CI)', () => {
    forceQuiet();
    const s = spinner();
    s.start('Transferring app image');
    s.stop('done');
    expect(spinnerInstances.length).toBe(0);
  });

  it('emits one line on start and one on stop, and dedupes repeated messages', () => {
    forceQuiet();
    const s = spinner();
    s.start('Transferring app image');
    for (let i = 0; i < 20; i++) s.message('Transferring app image'); // identical → no spam
    s.stop('App image transferred');
    expect(clackLog.info).toHaveBeenCalledTimes(1); // start only; repeats deduped
    expect(clackLog.info).toHaveBeenCalledWith('Transferring app image');
    expect(clackLog.success).toHaveBeenCalledWith('App image transferred');
  });

  it('stop(code=1) logs an error line, and still registers for progressLog', () => {
    forceQuiet();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = spinner();
    s.start('Working');
    progressLog('[retry] attempt 1/3'); // routes to the quiet spinner, not console
    expect(clackLog.info).toHaveBeenCalledWith('[retry] attempt 1/3');
    expect(err).not.toHaveBeenCalled();
    s.stop('Failed', 1);
    expect(clackLog.error).toHaveBeenCalledWith('Failed');
  });
});

describe('clipToWidth (prevents the wrap that defeats clack’s single-line erase)', () => {
  it('truncates a message wider than the terminal, with an ellipsis', () => {
    const out = clipToWidth('Transferring app image to 5.78.41.67 (sideload)...', 40);
    expect(out.length).toBeLessThanOrEqual(40 - 5);
    expect(out.endsWith('…')).toBe(true);
  });
  it('leaves a message that already fits untouched', () => {
    expect(clipToWidth('short', 40)).toBe('short');
  });
  it('does not clip when the terminal width is unknown', () => {
    const long = 'x'.repeat(200);
    expect(clipToWidth(long, undefined)).toBe(long);
  });

  // Regression: 2026-07-24 deploy log. clack renders "<frame>  <msg><dots>"
  // (3-col prefix, up to 3 dots) but its erase counts rows from the BARE
  // message — so a frame that outgrows the terminal by even one column
  // orphans its first row on every tick. At 49 cols the old 5-col reserve
  // left the dots=3 frame exactly 1 over: one leaked line per frame.
  it('reserves room for the frame prefix AND all 3 animation dots', () => {
    const msg = 'Transferring app image to 5.78.41.67 (sideloading over SSH)';
    for (const cols of [40, 49, 80]) {
      const out = clipToWidth(msg, cols);
      expect(3 + out.length + 3).toBeLessThanOrEqual(cols);
    }
  });
});

describe('animate-path spinner clips its message to the terminal width', () => {
  const origCols = process.stdout.columns;
  beforeEach(() => {
    forceAnimate();
    process.stdout.columns = 40;
  });
  afterEach(() => {
    process.stdout.columns = origCols;
  });

  it('passes a clipped (non-wrapping) message to the clack spinner start', () => {
    const s = spinner();
    s.start('Transferring app image to 5.78.41.67 (sideload)...');
    const arg = spinnerInstances[0].rawStart.mock.calls[0][0] as string;
    expect(3 + arg.length + 3).toBeLessThanOrEqual(40);
    expect(arg.endsWith('…')).toBe(true);
    s.stop(); // clear the module-level _active so it can't leak into the next test
  });

  // Timer spinners render " [59m 59s]"-style elapsed time after the message —
  // a wider suffix than the 3 dots, so the clip must reserve more.
  it('timer spinners reserve room for the elapsed-time suffix on start and message', () => {
    const s = spinner({ indicator: 'timer' });
    s.start('Waiting for the app to start serving requests over HTTPS');
    s.message('Still waiting for the app to start serving requests over HTTPS');
    const inst = spinnerInstances[0];
    const started = inst.rawStart.mock.calls[0][0] as string;
    const updated = inst.rawMessage.mock.calls[0][0] as string;
    // worst-case suffix " [599m 59s]" = 12 cols
    expect(3 + started.length + 12).toBeLessThanOrEqual(40);
    expect(3 + updated.length + 12).toBeLessThanOrEqual(40);
    s.stop();
  });
});

describe('progressLog / spinner registry', () => {
  beforeEach(forceAnimate); // these assert the clack delegation (TTY) path

  it('falls back to console.error when no spinner is active', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    progressLog('[retry] ssh 1.2.3.4: attempt 1/3 failed');
    expect(err).toHaveBeenCalledWith('[retry] ssh 1.2.3.4: attempt 1/3 failed');
  });

  it('routes through the active spinner (message, not console) while one is running', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = spinner();
    s.start('Working...');
    progressLog('[retry] ssh 1.2.3.4: attempt 1/3 failed');
    const inst = spinnerInstances[0];
    expect(inst.rawMessage).toHaveBeenCalledWith('[retry] ssh 1.2.3.4: attempt 1/3 failed');
    expect(err).not.toHaveBeenCalled();
  });

  it('returns to console.error after the spinner stops', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = spinner();
    s.start('Working...');
    s.stop('Done');
    progressLog('after stop');
    expect(err).toHaveBeenCalledWith('after stop');
  });

  it('delegates start/stop to the underlying clack spinner (transparent wrapper)', () => {
    const s = spinner();
    s.start('hi');
    s.stop('bye', 1);
    const inst = spinnerInstances[0];
    expect(inst.rawStart).toHaveBeenCalledWith('hi');
    expect(inst.rawStop).toHaveBeenCalledWith('bye', 1);
  });

  it('forwards options (e.g. { indicator: "timer" }) to the underlying clack spinner', () => {
    spinner({ indicator: 'timer' });
    expect(spinnerInstances[0].opts).toEqual({ indicator: 'timer' });
  });

  it('de-registers on .error() too (not just .stop) so progressLog does not leak to a dead line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = spinner();
    s.start('Destroying orphan...');
    // @ts-expect-error — clack spinner exposes .error(); our wrapper forwards it
    s.error('Failed');
    progressLog('after error');
    expect(err).toHaveBeenCalledWith('after error');
  });
});
