import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The repository root, found from where this file sits and never from the
 * working directory, so a test reads the same files wherever it is run from.
 * No trailing separator.
 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The text of a file in the repository, by its path from the root (`'src/scale.js'`, or in parts). */
export function readRepoFile(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf-8');
}

/**
 * The one recursive file walk for source censuses: tests that list the files
 * under a directory and pin their text. A census is only as good as the set
 * of files it scans, so there is one walk to read, and every census says its
 * scope in the same four words.
 *
 * It lists names and reads no file, so it never reads a `.env*` file. It does
 * not follow a symbolic link: a link is listed as a file, whatever it points
 * at.
 */
export interface SourceFilesOptions {
  /** Keep only files whose name ends with one of these (`'.js'`). Every file when left out. */
  exts?: readonly string[];
  /** Names to pass over, files and directories alike (`'node_modules'`). */
  skip?: Iterable<string>;
  /** Also stay out of every directory whose name starts with a dot. Dot files are still listed. */
  skipDotDirs?: boolean;
  /** Return paths relative to this directory. Left out, a path is its root joined with the way down. */
  relativeTo?: string;
}

/**
 * Every file under each root, depth first, in directory order. A root that is
 * missing or is not a directory throws: a census that scans nothing must
 * fail, not pass.
 */
export function sourceFiles(
  roots: string | readonly string[],
  { exts, skip, skipDotDirs = false, relativeTo }: SourceFilesOptions = {},
): string[] {
  const skipped = new Set(skip);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(skipDotDirs && entry.name.startsWith('.'))) walk(full);
      } else if (!exts || exts.some((ext) => entry.name.endsWith(ext))) {
        out.push(relativeTo === undefined ? full : relative(relativeTo, full));
      }
    }
  };
  for (const root of typeof roots === 'string' ? [roots] : roots) walk(root);
  return out;
}
