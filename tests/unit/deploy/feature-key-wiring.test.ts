import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// These guard the "manifest actually references the keys" half of feature-key
// propagation. Without them, the CLI can seed vibecarbon-secrets perfectly and
// the app pod / container still never reads STRIPE_*/SMTP_*/BILLING_PROVIDER.
// The repo has no YAML parser dependency, so these assert on raw text.
const CARBON = join(process.cwd(), 'carbon');

describe('k8s app deployment wires vibecarbon-secrets', () => {
  const yaml = readFileSync(join(CARBON, 'k8s/base/app/deployment.yaml'), 'utf-8');

  it('envFrom pulls in the vibecarbon-secrets Secret', () => {
    // `- secretRef:` followed by `name: vibecarbon-secrets` (any indentation).
    expect(yaml).toMatch(/-\s*secretRef:\s*\n\s*name:\s*vibecarbon-secrets/);
  });

  it('keeps the existing vibecarbon-config ConfigMap reference', () => {
    expect(yaml).toMatch(/-\s*configMapRef:\s*\n\s*name:\s*vibecarbon-config/);
  });
});

describe('compose app service wires the staged .env', () => {
  const yaml = readFileSync(join(CARBON, 'docker-compose.yml'), 'utf-8');
  // Slice out just the `app:` service block so we don't match another service.
  const appBlock = yaml.slice(
    yaml.indexOf('\n  app:'),
    yaml.indexOf('\n  # ===', yaml.indexOf('\n  app:') + 1),
  );

  it('the app service has env_file including .env', () => {
    expect(appBlock).toMatch(/env_file:\s*\n\s*-\s*\.env/);
  });
});
