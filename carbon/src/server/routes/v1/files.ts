import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../lib/logger';
import { createRateLimiter } from '../../lib/rate-limiter';
import { presignUpload, StorageInputError, StorageNotConfiguredError } from '../../lib/storage';
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

export { filesRoutes };
