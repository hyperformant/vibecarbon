import { afterEach, describe, expect, it, vi } from 'vitest';
import { resizeImage } from '@/lib/image-resize';

function bitmap(w: number, h: number) {
  return { width: w, height: h, close: vi.fn() };
}

function stubOffscreen(canvasArgs: number[], convertToBlob: () => Promise<Blob>) {
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(w: number, h: number) {
        canvasArgs.push(w, h);
      }
      getContext() {
        return { drawImage: vi.fn() };
      }
      convertToBlob = convertToBlob;
    }
  );
}

describe('resizeImage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downscales so the longest edge is maxEdge and encodes webp at 0.9', async () => {
    const convertToBlob = vi.fn(async () => new Blob(['x'], { type: 'image/webp' }));
    const canvasArgs: number[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap(1024, 512))
    );
    stubOffscreen(canvasArgs, convertToBlob);
    const out = await resizeImage(new File(['a'], 'a.png', { type: 'image/png' }), 256);
    expect(canvasArgs).toEqual([256, 128]);
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/webp', quality: 0.9 });
    expect(out.type).toBe('image/webp');
  });

  it('does not upscale small images', async () => {
    const canvasArgs: number[] = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap(100, 50))
    );
    stubOffscreen(canvasArgs, async () => new Blob(['x'], { type: 'image/webp' }));
    await resizeImage(new File(['a'], 'a.png', { type: 'image/png' }), 256);
    expect(canvasArgs).toEqual([100, 50]);
  });

  it('returns the original file when decoding fails', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('bad');
      })
    );
    const file = new File(['a'], 'a.png', { type: 'image/png' });
    expect(await resizeImage(file, 256)).toBe(file);
  });

  it('returns gifs untouched', async () => {
    const spy = vi.fn();
    vi.stubGlobal('createImageBitmap', spy);
    const file = new File(['a'], 'a.gif', { type: 'image/gif' });
    expect(await resizeImage(file, 256)).toBe(file);
    expect(spy).not.toHaveBeenCalled();
  });
});
