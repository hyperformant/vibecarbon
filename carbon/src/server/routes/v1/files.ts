import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import {
  isStorageConfigured,
  parseObjectKey,
  presignRead,
  presignUpload,
  StorageInputError,
  StorageNotConfiguredError,
} from '../../lib/storage';
import type { HonoVariables } from '../../types';

const filesRoutes = new Hono<{ Variables: HonoVariables }>();

// 30 presigns per 10 minutes per user (the limiter keys by user id when signed in).
filesRoutes.use('/presign', createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }));

// z.object strips unknown keys by default: the key's owner always comes from the session.
const presignSchema = z.object({
  kind: z.enum(['avatar', 'private']),
  contentType: z.string().min(1).max(127),
  size: z.number().int(),
});

/**
 * Create a presigned PUT URL for a direct-to-storage upload.
 */
filesRoutes.post('/presign', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let body: z.infer<typeof presignSchema>;
  try {
    const parsed = presignSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    body = parsed.data;
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }

  try {
    const result = await presignUpload({
      kind: body.kind,
      userId: user.id,
      contentType: body.contentType,
      size: body.size,
    });
    return c.json({ ...result, fileUrl: `/api/files/${result.key}` });
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return c.json({ error: 'storage_not_configured' }, 503);
    }
    if (err instanceof StorageInputError) {
      return c.json({ error: err.message }, 400);
    }
    logger.error({ err }, 'Failed to presign upload');
    return c.json({ error: 'Failed to presign upload' }, 500);
  }
});

const fileReadRoutes = new Hono<{ Variables: HonoVariables }>();

const READ_PREFIX = '/api/files/';

/**
 * Serve a stored file by redirecting to a short-lived presigned GET URL.
 * Avatars are public through the app; private files are owner-only. Every
 * refusal is a 404 so callers cannot probe which keys exist.
 */
fileReadRoutes.get('/*', async (c) => {
  if (!isStorageConfigured()) {
    return c.notFound();
  }

  // SECURITY: take the raw path and never decode it. parseObjectKey is a strict
  // allowlist match, so encoded slashes and dot segments simply fail to parse.
  const raw = c.req.path.startsWith(READ_PREFIX) ? c.req.path.slice(READ_PREFIX.length) : '';
  const parsed = parseObjectKey(raw);
  if (!parsed) {
    return c.notFound();
  }

  if (parsed.kind === 'private') {
    const user = c.get('user');
    if (!user || user.id !== parsed.userId) {
      return c.notFound();
    }
  }

  try {
    const url = await presignRead(parsed.key);
    c.header('Cache-Control', 'private, max-age=60');
    return c.redirect(url, 302);
  } catch (err) {
    logger.error({ err }, 'Failed to presign file read');
    return c.notFound();
  }
});

export { fileReadRoutes, filesRoutes };
