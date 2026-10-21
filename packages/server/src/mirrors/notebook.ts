/**
 * Jupyter notebooks for repository mirrors ([06] §7.1): searched and read as their cell sources only. Outputs
 * (often megabytes of base64 images and tables) are dropped. Each cell starts with a marker line
 * `# %% [<type>] cell <n>`, so search hits and `read_repo_file` share one line numbering, and a line maps back to
 * its cell.
 */
export interface NotebookCell {
  /** 1-based cell number. */
  cell: number;
  cell_type: string;
  /** Line number of the cell's marker line in the rendered text (1-based). */
  start_line: number;
  /** Source lines after the marker. */
  lines: number;
}

export interface RenderedNotebook {
  text: string;
  cells: NotebookCell[];
  language: string | null;
}

export const NOTEBOOK_MARKER = /^# %% \[[a-z_-]+\] cell \d+$/;

function sourceText(src: unknown): string {
  if (typeof src === 'string') return src;
  if (Array.isArray(src)) return src.map((s) => (typeof s === 'string' ? s : '')).join('');
  return '';
}

/** Render nbformat 4 (`cells[].source`) or 3 (`worksheets[].cells[].input|source`); null when `raw` is not a notebook. */
export function renderNotebook(raw: string): RenderedNotebook | null {
  let nb: any;
  try {
    nb = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!nb || typeof nb !== 'object') return null;
  const cells: any[] | null = Array.isArray(nb.cells) ? nb.cells : Array.isArray(nb.worksheets) ? nb.worksheets.flatMap((w: any) => (Array.isArray(w?.cells) ? w.cells : [])) : null;
  if (!cells) return null;
  const lines: string[] = [];
  const out: NotebookCell[] = [];
  cells.forEach((c, i) => {
    const type = typeof c?.cell_type === 'string' && /^[a-z_-]+$/.test(c.cell_type) ? c.cell_type : 'unknown';
    const body = sourceText(c?.source ?? c?.input).replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const bodyLines = body === '' ? [] : body.split('\n');
    out.push({ cell: i + 1, cell_type: type, start_line: lines.length + 1, lines: bodyLines.length });
    lines.push(`# %% [${type}] cell ${i + 1}`, ...bodyLines);
  });
  const meta = nb.metadata ?? {};
  const language = meta.kernelspec?.language ?? meta.language_info?.name ?? meta.language ?? null;
  return { text: lines.join('\n') + (lines.length ? '\n' : ''), cells: out, language: typeof language === 'string' ? language : null };
}

/** The cell a rendered line belongs to; `cell_line` 0 is the marker line itself. */
export function locate(cells: NotebookCell[], line: number): { cell: number; cell_type: string; cell_line: number } | null {
  let lo = 0;
  let hi = cells.length - 1;
  let hit: NotebookCell | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cells[mid]!.start_line <= line) {
      hit = cells[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!hit || line > hit.start_line + hit.lines) return null;
  return { cell: hit.cell, cell_type: hit.cell_type, cell_line: line - hit.start_line };
}
