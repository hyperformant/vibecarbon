/**
 * The locale files present on disk define the languages this project ships.
 *
 * Globbing rather than importing each one by name means adding or removing a
 * language is a matter of adding or removing its JSON file, with no code to
 * edit and nothing to keep in sync. `eager` with `import: 'default'` is the
 * form Vite tree-shakes, so a single-locale project bundles a single locale
 * instead of carrying the others as dead weight.
 *
 * This lives apart from `i18n.ts` on purpose. Asking "which languages does
 * this build have" should not drag in i18next's module-level `init()` as a
 * side effect — the language switcher needs the answer, not the framework.
 *
 * The project ships English only. Translations are reintroduced by adding
 * locale files back; see
 * the globalization-cli-design spec.
 */
const localeModules = import.meta.glob<Record<string, unknown>>('../locales/*.json', {
  eager: true,
  import: 'default',
});

/** i18next `resources`, keyed by language code. */
export const localeResources = Object.fromEntries(
  Object.entries(localeModules).map(([path, translation]) => {
    const code = path.match(/([^/]+)\.json$/)?.[1];
    if (!code) throw new Error(`Unparseable locale filename: ${path}`);
    return [code, { translation }];
  })
);

/** Language codes this build actually carries, for the switcher to offer. */
export const availableLanguages = Object.keys(localeResources).sort();
