// Spinner diagnostic — run in the SAME terminal you deploy from:
//   node ~/repos/vibecarbon/scripts/spinner-diagnose.mjs
//
// Watch the two spinners it draws and tell me which (if any) SPAM lines vs
// animate as ONE line. That isolates terminal-vs-deploy-write-chain.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = process.env;

console.log('=== ENVIRONMENT ===');
for (const [k, v] of Object.entries({
  'stdout.isTTY': process.stdout.isTTY,
  columns: process.stdout.columns,
  TERM: env.TERM,
  TERM_PROGRAM: env.TERM_PROGRAM,
  CI: JSON.stringify(env.CI),
  GITHUB_ACTIONS: env.GITHUB_ACTIONS,
  NO_COLOR: env.NO_COLOR,
  FORCE_COLOR: env.FORCE_COLOR,
})) {
  console.log(`  ${k} = ${v}`);
}

const p = await import('@clack/prompts');
console.log(`  clack.isCI() = ${typeof p.isCI === 'function' ? p.isCI() : '(n/a)'}`);

// --- PHASE A: bare clack spinner, no deploy wrapping -----------------------
console.log('\n=== PHASE A: bare clack spinner (watch it for ~3s) ===');
console.log('   >>> Is the next thing ONE animating line, or MANY lines? <<<');
await sleep(400);
{
  const s = p.spinner();
  s.start('PHASE A — transferring (bare clack)');
  await sleep(3000);
  s.stop('PHASE A done');
}

// --- PHASE B: through the real deploy write-chain (tee + dead-air guard) ----
console.log('\n=== PHASE B: same spinner INSIDE the deploy log tee + guard ===');
console.log('   >>> Does THIS one spam lines? (this is the real deploy path) <<<');
await sleep(400);
{
  const { withDeployLog } = await import('../src/lib/deploy-logger.js');
  const { spinner } = await import('../src/lib/cli/progress.js');
  await withDeployLog('spinner-diag', async () => {
    const s = spinner();
    s.start('PHASE B — transferring (via deploy tee + guard)');
    await sleep(3000);
    s.stop('PHASE B done');
  });
}

console.log('\n=== DONE ===');
console.log('Tell me: did PHASE A spam? did PHASE B spam? (+ paste the ENVIRONMENT block)');
