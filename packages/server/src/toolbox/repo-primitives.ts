/**
 * Repository mirror primitives ([06] §7.1; [11] §4): search and read the git repositories the server mirrors
 * (`repos:` in breadboard.yaml). Subagents need a `repos` grant naming the mirror; members read every mirror.
 * The Breadboard's own configuration is not a mirror: read it with `search_config` / `read_config`.
 */
import { obj, STRING_ARRAY, type PrimitiveDef, type PrimitivesDeps } from './primitive-defs.js';

const REPO = { type: 'string', minLength: 1, description: 'Repository mirror name (`get_breadboard_overview` lists them under `repos`). May be omitted when exactly one is available to you.' };
const COMMIT = { type: 'string', minLength: 7, maxLength: 64, description: 'Commit SHA to use instead of the latest (e.g. one a previous result cited). Skips the freshness check.' };

export function repoCatalog(d: PrimitivesDeps): PrimitiveDef[] {
  return [
    {
      name: 'search_repo',
      scope: 'knowledge:read',
      description:
        "Search a mirrored git repository's files at its latest commit (refreshed when more than a few minutes old) like grep: `pattern` is a literal string unless `regex: true` (PCRE). Narrow with `paths` / `exclude` git globs (`*` stays within a directory, `**` crosses directories, a plain directory covers everything under it, e.g. `docs`, `src/**/*.py`). Returns matching files with line numbers, grep-style snippets (`12:` match, `11-` context) and the commit SHA to cite and to pass to `read_repo_file`. Jupyter notebooks are searched by cell source only (hits carry `cell` and `cell_line`); binary and oversized files are skipped. Use `files_only` for a cheap list of matching paths. Not for the Breadboard's own circuits, subagents or tools: use `search_config` / `read_config`.",
      input_schema: obj(
        {
          repo: REPO,
          pattern: { type: 'string', minLength: 1, maxLength: 1000, description: 'Text to find (one line). Literal unless `regex` is true.' },
          regex: { type: 'boolean', description: 'Treat `pattern` as a Perl-compatible regular expression (default false).' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive (default false).' },
          word: { type: 'boolean', description: 'Match whole words only (default false).' },
          paths: STRING_ARRAY('Only search paths matching these git globs (max 20).'),
          exclude: STRING_ARRAY('Skip paths matching these git globs (max 20).'),
          context: { type: 'integer', minimum: 0, maximum: 10, description: 'Context lines around each match (default 2).' },
          max_results: { type: 'integer', minimum: 1, maximum: 200, description: 'Max matching lines overall (default 40).' },
          max_per_file: { type: 'integer', minimum: 1, maximum: 50, description: 'Max matching lines per file (default 5).' },
          files_only: { type: 'boolean', description: 'Return only matching paths with match counts (up to 500 files).' },
          commit: COMMIT,
          max_chars: { type: 'integer', minimum: 0, description: 'Total snippet characters (default 20000; 0 = up to 200000).' },
        },
        ['pattern'],
      ),
      handler: async (a, p) => d.mirrors().search(a, p),
    },
    {
      name: 'read_repo_file',
      scope: 'knowledge:read',
      description:
        "Read a file (or a line range of it) from a mirrored git repository, or list a directory (`path` empty or a directory). Lines come numbered; follow `next_start_line` when the text was cut at `max_chars`. Pass the `commit` a `search_repo` result cited to read exactly what it matched. Notebooks are shown as their cell sources (`# %% [code] cell 3` markers, outputs omitted, the same line numbers `search_repo` reports); `raw: true` returns the .ipynb JSON.",
      input_schema: obj(
        {
          repo: REPO,
          path: { type: 'string', maxLength: 1024, description: 'Repo-relative path of a file or directory (default: the root).' },
          commit: COMMIT,
          start_line: { type: 'integer', minimum: 1, description: 'First line to return (default 1).' },
          end_line: { type: 'integer', minimum: 1, description: 'Last line to return (default: end of file).' },
          raw: { type: 'boolean', description: 'For notebooks: the raw .ipynb JSON instead of the cell view (default false).' },
          max_chars: { type: 'integer', minimum: 0, description: 'Max characters of text (default 20000; 0 = up to 200000).' },
        },
        [],
      ),
      handler: async (a, p) => d.mirrors().read(a, p),
    },
  ];
}
