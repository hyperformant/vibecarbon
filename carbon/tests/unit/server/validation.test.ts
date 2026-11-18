import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJsonBody } from '@server/lib/validation';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  age: z.number({ message: 'Age must be a number' }),
});

const app = new Hono().post('/', async (c) => {
  const parsed = await parseJsonBody(c, schema);
  if ('response' in parsed) return parsed.response;
  return c.json({ got: parsed.data });
});

const post = (body: string) =>
  app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('parseJsonBody', () => {
  it('hands the handler the parsed body', async () => {
    const res = await post(JSON.stringify({ name: 'Ada', age: 36 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { name: 'Ada', age: 36 } });
  });

  it('answers 400 with every schema issue, joined', async () => {
    const res = await post(JSON.stringify({ name: '', age: 'old' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Name is required, Age must be a number' });
  });

  it('answers 400 Invalid JSON body when the body is not JSON', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });
});
