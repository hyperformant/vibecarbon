/**
 * n8n ForwardAuth SSO Hook
 *
 * Reads X-User-Email set by Traefik ForwardAuth, looks up or auto-creates
 * the n8n user, and issues a session cookie — bypassing n8n's login page.
 *
 * When ForwardAuth headers are absent (dev mode without Traefik, or direct
 * container access), falls through to n8n's normal login flow.
 *
 * Loaded via EXTERNAL_HOOK_FILES environment variable.
 */

const SKIP_PATHS = ['/healthz', '/webhook', '/assets', '/rest/oauth2-credential'];

function shouldSkip(url) {
  return SKIP_PATHS.some((p) => url.startsWith(p));
}

module.exports = {
  n8n: {
    ready: [
      async function (server) {
        const userRepo = this.dbCollections?.User;
        if (!userRepo) {
          console.warn('[hooks.js] User repository not available — SSO hook disabled');
          return;
        }

        // Get AuthService from DI container for issueCookie
        let authService;
        try {
          const { Container } = require('@n8n/di');
          const { AuthService } = require('/usr/local/lib/node_modules/n8n/dist/auth/auth.service');
          authService = Container.get(AuthService);
        } catch (err) {
          console.warn('[hooks.js] Could not resolve AuthService:', err.message);
        }

        const app = server.app;
        if (!app) {
          console.warn('[hooks.js] server.app not available');
          return;
        }

        // Express 5 uses app.router.stack, Express 4 uses app._router.stack
        const layers = app.router?.stack ?? app._router?.stack;
        if (!layers) {
          console.warn('[hooks.js] Could not access Express router stack — SSO hook disabled');
          return;
        }

        let cookieParserIdx = -1;
        for (let i = 0; i < layers.length; i++) {
          if (layers[i].name === 'cookieParser') {
            cookieParserIdx = i;
            break;
          }
        }

        const middleware = async (req, res, next) => {
          try {
            if (shouldSkip(req.url)) return next();

            // Skip if session already exists
            if (req.cookies?.['n8n-auth']) return next();

            const email = req.headers['x-user-email'];
            if (!email) return next(); // No ForwardAuth headers — normal login

            let user = await userRepo.findOne({
              where: { email },
              relations: ['role'],
            });

            if (!user) {
              // Auto-create user with owner role and random password
              const crypto = require('node:crypto');
              const { hashSync } = require('bcryptjs');
              const randomPassword = crypto.randomBytes(32).toString('hex');

              user = userRepo.create({
                email,
                firstName: email.split('@')[0],
                lastName: '',
                password: hashSync(randomPassword, 10),
                roleSlug: 'global:owner',
              });
              user = await userRepo.save(user);
              // Reload with role relation
              user = await userRepo.findOne({
                where: { email },
                relations: ['role'],
              });
            }

            if (!user) return next();

            // Issue session cookie via AuthService
            if (authService) {
              try {
                authService.issueCookie(res, user, false, undefined);
              } catch (cookieErr) {
                console.error('[hooks.js] SSO: issueCookie failed:', cookieErr.message);
              }
            }

            return next();
          } catch (err) {
            console.error('[hooks.js] ForwardAuth SSO error:', err.message);
            return next();
          }
        };

        // Inject middleware after cookie-parser so req.cookies is available.
        // Must create a proper Layer instance (Express 5 router calls layer.match()).
        if (cookieParserIdx >= 0) {
          try {
            const Layer = require('router/lib/layer');
            const layer = new Layer('/', { end: false }, middleware);
            layers.splice(cookieParserIdx + 1, 0, layer);
            console.log('[hooks.js] ForwardAuth SSO middleware installed');
          } catch (err) {
            console.warn('[hooks.js] Could not create router Layer:', err.message);
          }
        } else {
          console.warn('[hooks.js] cookie-parser not found — SSO hook disabled');
        }
      },
    ],
  },
};
