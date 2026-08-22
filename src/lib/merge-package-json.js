/**
 * Smart package.json merge for upgrades
 *
 * Merges the template package.json into the user's existing one:
 * - Updates versions of shared dependencies (template wins)
 * - Adds new template dependencies the user doesn't have
 * - Preserves all user-added dependencies not in the template
 * - Merges pnpm/npm config sections (overrides, etc.)
 * - Updates scripts from template, preserves user-added scripts
 * - Preserves other top-level fields the user may have added
 */

/**
 * Deep-merge two plain objects. Source values win for shared keys.
 * Arrays are replaced, not concatenated.
 *
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Merge dependency maps: update shared deps to template versions, add new ones, keep user extras.
 *
 * @param {Record<string, string>} [userDeps]
 * @param {Record<string, string>} [templateDeps]
 * @returns {Record<string, string>}
 */
function mergeDeps(userDeps, templateDeps) {
  if (!templateDeps) return userDeps || {};
  if (!userDeps) return { ...templateDeps };

  const merged = { ...userDeps };

  for (const [pkg, version] of Object.entries(templateDeps)) {
    // Update existing or add new — template version wins
    merged[pkg] = version;
  }

  return merged;
}

/**
 * Merge the user's package.json with the template's package.json.
 *
 * @param {object} userPkg - The user's current package.json (parsed)
 * @param {object} templatePkg - The template's package.json (parsed)
 * @returns {object} - The merged package.json
 */
export function mergePackageJson(userPkg, templatePkg) {
  // Start from the user's package.json to preserve all their fields
  const merged = { ...userPkg };

  // Update dependencies (template versions win, user extras preserved)
  merged.dependencies = mergeDeps(userPkg.dependencies, templatePkg.dependencies);
  merged.devDependencies = mergeDeps(userPkg.devDependencies, templatePkg.devDependencies);

  // Merge scripts: template scripts win, user-added scripts preserved
  merged.scripts = { ...userPkg.scripts, ...templatePkg.scripts };

  // Merge npm/bun overrides (security pins live here for the default manager)
  if (templatePkg.overrides) {
    merged.overrides = deepMerge(userPkg.overrides || {}, templatePkg.overrides);
  }

  // Merge pnpm config section (overrides, onlyBuiltDependencies, etc.)
  if (templatePkg.pnpm) {
    merged.pnpm = deepMerge(userPkg.pnpm || {}, templatePkg.pnpm);
  }

  // Update these standard fields from template
  merged.type = templatePkg.type;
  merged.version = templatePkg.version;
  merged.private = templatePkg.private;

  return merged;
}
