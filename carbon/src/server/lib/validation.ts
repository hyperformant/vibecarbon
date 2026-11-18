import type { Context } from 'hono';
import type { z } from 'zod';

/**
 * Read a JSON request body and validate it against `schema`. Returns the
 * parsed body as `data`, or a 400 to answer with as `response`: the schema's
 * issue messages joined (`{ error: 'Name is required, ...' }`), or
 * `{ error: 'Invalid JSON body' }` when the body is not JSON.
 *
 *   const parsed = await parseJsonBody(c, createItemSchema);
 *   if ('response' in parsed) return parsed.response;
 *   const body = parsed.data;
 */
export async function parseJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T
): Promise<{ data: z.infer<T> } | { response: Response }> {
  try {
    const result = schema.safeParse(await c.req.json());
    if (!result.success) {
      const errors = result.error.issues.map((e) => e.message).join(', ');
      return { response: c.json({ error: errors }, 400) };
    }
    return { data: result.data };
  } catch {
    return { response: c.json({ error: 'Invalid JSON body' }, 400) };
  }
}
