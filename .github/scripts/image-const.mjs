// Print one export of src/lib/images.js: `node .github/scripts/image-const.mjs NAME`.
// Workflows read image refs through this, never by grepping the source, so a
// formatter wrapping a constant cannot silently empty a ref.
import { fileURLToPath } from 'node:url';

/** The named export as a string, or throw naming the constant. */
export function readImageConst(module, name) {
  const value = module[name];
  const ok = (typeof value === 'string' && value !== '') || typeof value === 'number';
  if (!ok) {
    throw new Error(`images.js export ${name} is missing, empty, or not a string or number`);
  }
  return String(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const images = await import(new URL('../../src/lib/images.js', import.meta.url));
    console.log(readImageConst(images, process.argv[2] ?? ''));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
