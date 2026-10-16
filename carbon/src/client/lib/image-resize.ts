/**
 * Downscale an image in the browser so avatars stay small before upload.
 *
 * Decodes with `createImageBitmap`, draws onto an `OffscreenCanvas` (or a
 * `<canvas>` when OffscreenCanvas is missing) and re-encodes. Never throws:
 * when decoding or encoding is unavailable the original file is returned, and
 * GIFs are returned untouched because re-encoding would drop the animation.
 */
export async function resizeImage(
  file: File,
  maxEdge: number,
  type: 'image/webp' = 'image/webp'
): Promise<Blob> {
  if (file.type === 'image/gif') return file;

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const quality = 0.9;

      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, width, height);
        return await canvas.convertToBlob({ type, quality });
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, type, quality)
      );
      return blob ?? file;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return file;
  }
}
