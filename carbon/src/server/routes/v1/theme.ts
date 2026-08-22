import { Hono } from 'hono';
import { z } from 'zod';
import { isSuperAdmin } from '../../lib/auth';
import { logger } from '../../lib/logger';
import { supabaseAdmin } from '../../lib/supabase';
import type { HonoVariables } from '../../types';

const themeRoutes = new Hono<{ Variables: HonoVariables }>();

// SECURITY: theme values are stored via PATCH and served publicly via GET, then
// the client string-builds a `<style>` block from them (client/lib/theme.ts).
// Unconstrained strings would allow CSS injection (breaking out of a
// declaration with `;}` to add arbitrary rules). Constrain each field to a
// known CSS color/length grammar so no structural characters can escape.
//
// Colors: hex (#rgb/#rgba/#rrggbb/#rrggbbaa) or a rgb()/rgba()/hsl()/hsla()/
// oklch() function whose body is limited to digits, dot, comma, %, slash and
// whitespace. Radius: a non-negative number with a px/rem/em/% unit, or `0`.
const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?|oklch)\([\d.,%/\s]+\))$/;
const RADIUS_RE = /^(0|\d*\.?\d+(px|rem|em|%))$/;

const colorField = z.string().regex(COLOR_RE, 'Invalid color value').optional();
const radiusField = z.string().regex(RADIUS_RE, 'Invalid radius value').optional();

const colorSchemaFields = {
  primary: colorField,
  primaryDim: colorField,
  primaryForeground: colorField,
  secondaryAccent: colorField,
  secondaryAccentForeground: colorField,
  destructive: colorField,
  warning: colorField,
  success: colorField,
};

// NOTE: schema is non-strict (unknown keys are stripped, not rejected). The
// admin UI also sends gradientStart/gradientEnd/card, which are NOT part of the
// stored/served theme — they've always been stripped here, so the client falls
// back to its built-in defaults for them. That means they are not a stored-XSS
// vector (they never persist). Validating them would require intentionally
// persisting them, which is a product decision, not a security fix — left as-is.
const themeSchema = z.object({
  light: z.object(colorSchemaFields).optional(),
  dark: z
    .object({
      primary: colorField,
      primaryDim: colorField,
      primaryForeground: colorField,
      secondaryAccent: colorField,
      secondaryAccentForeground: colorField,
    })
    .optional(),
  radius: radiusField,
  smoothScrollEnabled: z.boolean().optional(),
  smoothScrollIntensity: z.number().min(0).max(100).optional(),
});

// ============================================================================
// GET / — Public. Returns the current app theme.
// ============================================================================

themeRoutes.get('/', async (c): Promise<Response> => {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'app_theme')
      .single();

    if (error || !data) {
      logger.debug({ error }, 'No app_theme found, returning default');
      return c.json({ theme: {} });
    }

    return c.json({ theme: data.value });
  } catch (err) {
    logger.error({ error: err }, 'Failed to fetch app theme');
    return c.json({ theme: {} });
  }
});

// ============================================================================
// PATCH / — Super admin only. Upserts the app theme.
// ============================================================================

themeRoutes.patch('/', async (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!isSuperAdmin(user)) {
    return c.json({ error: 'Super admin access required' }, 403);
  }

  // Validate request body
  const body = await c.req.json();
  const parsed = themeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid theme data', details: parsed.error.flatten() }, 400);
  }

  const theme = parsed.data;

  try {
    const { error } = await supabaseAdmin
      .from('app_settings')
      .upsert({ key: 'app_theme', value: theme, updated_by: user.id }, { onConflict: 'key' });

    if (error) {
      logger.error({ error, userId: user.id }, 'Failed to save app theme');
      return c.json({ error: 'Failed to save theme' }, 500);
    }

    logger.info({ userId: user.id }, 'App theme updated');

    return c.json({ success: true, theme });
  } catch (err) {
    logger.error({ error: err, userId: user.id }, 'Failed to save app theme');
    return c.json({ error: 'Failed to save theme' }, 500);
  }
});

export { themeRoutes };
