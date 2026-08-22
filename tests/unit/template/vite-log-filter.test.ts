import { describe, expect, it } from 'vitest';
import { isViteUrlBannerLine } from '../../../carbon/scripts/lib/vite-log-filter.js';

describe('isViteUrlBannerLine', () => {
  it('drops the Local and Network URL banner lines', () => {
    expect(isViteUrlBannerLine('  ➜  Local:   http://localhost:5373/')).toBe(true);
    expect(isViteUrlBannerLine('  ➜  Network: http://192.168.4.137:5373/')).toBe(true);
  });

  it('drops the keyboard-shortcut help line', () => {
    expect(isViteUrlBannerLine('  ➜  press h + enter to show help')).toBe(true);
  });

  it('keeps the readiness line, HMR updates, and errors', () => {
    expect(isViteUrlBannerLine('  VITE v8.0.16  ready in 502 ms')).toBe(false);
    expect(isViteUrlBannerLine('5:02:06 PM [vite] hmr update /src/App.tsx')).toBe(false);
    expect(isViteUrlBannerLine('[vite] Internal server error: oops at http://x')).toBe(false);
  });

  it('drops the banner as Vite actually composes it in a TTY (reset between label and colon)', () => {
    // bold("Local") + ":" → the colon sits OUTSIDE the colour wrapper, so the
    // raw line contains "Local\x1b[22m:", never the literal "Local:".
    const local = `  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m`;
    const network = `  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[36mhttp://192.168.4.137:\x1b[1m5173\x1b[22m/\x1b[39m`;
    const press = `\x1b[2m\x1b[32m  ➜\x1b[39m\x1b[22m\x1b[2m  press \x1b[22m\x1b[1mh + enter\x1b[22m\x1b[2m to show help\x1b[22m`;
    expect(isViteUrlBannerLine(local)).toBe(true);
    expect(isViteUrlBannerLine(network)).toBe(true);
    expect(isViteUrlBannerLine(press)).toBe(true);
  });

  it('is colour-independent and null-safe', () => {
    expect(isViteUrlBannerLine('\x1b[32m  ➜  Local:\x1b[0m http://localhost:5373/')).toBe(true);
    expect(isViteUrlBannerLine(undefined)).toBe(false);
  });
});
