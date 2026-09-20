/**
 * Synthetic values shared by the dotenv oracle tests.
 *
 * `ORACLE_VALUES` must read back identically from Node's `util.parseEnv`,
 * `dotenv`, and `dotenv-expand` once written through
 * `src/lib/dotenv.js`'s `formatDotenvLine` — see
 * `tests/unit/lib/dotenv-oracle.test.ts`. `REFUSED_VALUES` must be refused by
 * `dotenvValueProblem`. The Compose leg of the same oracle lives in
 * `tests/integration/docker/dotenv-compose-oracle.test.ts` and imports this
 * same fixture. Every value here is synthetic — never a real secret.
 */

export const ORACLE_VALUES: Record<string, string> = {
  EMPTY: '',
  PLAIN: 'plain',
  BASE64: 'YWJj+/==',
  JWT: 'eyJhbGciOi.eyJpc3Mi.SflKxwRJ-_',
  URL: 'https://x.example:8443/p?a=1&b=2#frag',
  SPACES: 'with two  spaces',
  HASH: 'abc#def',
  SINGLE: "it's",
  DOUBLE: 'say "hi"',
  BACKSLASH: 'back\\slash\\n',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal .env value asserted verbatim, not a JS template
  DOLLAR: 'cost $5, $HOME and ${HOME} stay literal',
  NEWLINE: 'line1\nline2\n',
  PEM: '-----BEGIN X-----\nabc\ndef==\n-----END X-----\n',
  UNICODE: 'émoji ✓ 日本',
  PUNCT: 'semi;colon*star!bang?q&amp|pipe<gt>~tilde^caret(paren)[br]{brace}',
  BACKTICK: 'tick `x` tick',
  EQUALS: 'a=b=c',
  LEAD_TRAIL: '  padded  ',
  COMMENTISH: ' # not a comment',
};

export const REFUSED_VALUES: Record<string, string> = {
  MIXED_QUOTES: `both ' and "`,
  QUOTE_DOLLAR: "quote ' and $X",
  NEWLINE_DOUBLE: 'nl\nand "q"',
  TAB: 'tab\there',
  CR: 'cr\r\n',
  VITE_DOLLAR: 'https://x/$y',
};
