/** Rendering for manifest lint / security diff findings (status = icon + label, never color alone). */
import { ShieldAlert, AlertTriangle, Info } from 'lucide-react';
import type { Snapshot, DiffRenderer } from '../components/snapshot';
import { MultiFileDiff } from '../components/Diff';
import { securityDiff, lintManifest, sortFindings, type Finding } from './manifestLint';

const ICON = { risk: ShieldAlert, warn: AlertTriangle, info: Info } as const;
const LABEL = { risk: 'Security', warn: 'Warning', info: 'Note' } as const;
const CLS = { risk: 'text-danger-fg', warn: 'text-warn-fg', info: 'text-fg-muted' } as const;

export function FindingsList({ findings, empty }: { findings: Finding[]; empty?: string }) {
  if (!findings.length) return empty ? <div className="text-xs text-fg-subtle">{empty}</div> : null;
  return (
    <ul className="space-y-1 text-xs">
      {sortFindings(findings).map((f, i) => {
        const I = ICON[f.severity];
        return (
          <li key={i} className="flex items-start gap-1.5">
            <I className={`mt-0.5 size-3.5 shrink-0 ${CLS[f.severity]}`} aria-hidden />
            <span className={`shrink-0 font-medium ${CLS[f.severity]}`}>{LABEL[f.severity]}</span>
            <span className="shrink-0 rounded bg-sunken px-1 font-mono text-[10px] text-fg-muted">{f.area}</span>
            <span>{f.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Security-relevant summary block shown above any tool diff. */
export function SecurityDiffBlock({ base, next, title = 'Security-relevant changes' }: { base: any; next: any; title?: string }) {
  const f = securityDiff(base, next);
  const risks = f.filter((x) => x.severity === 'risk').length;
  return (
    <div className={`rounded-md border p-2 ${risks ? 'border-danger/40 bg-danger-soft' : 'border-line bg-sunken'}`}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
        <ShieldAlert className="size-3.5" aria-hidden />
        {title}
        <span className="font-normal text-fg-muted">{f.length ? `${risks} widening, ${f.length - risks} other` : 'none'}</span>
      </div>
      <FindingsList findings={f} empty="No limit, egress, capability, exposure or hidden-setting changes." />
    </div>
  );
}

export function ToolDiff({ base, next }: { base: Snapshot; next: Snapshot }) {
  const prefix = (next.dir ?? base.dir) ? `${next.dir ?? base.dir}/` : undefined;
  const ep = next.parsed?.entrypoint;
  const lint = next.parsed ? lintManifest(next.parsed, { entrypointExists: ep ? `${next.dir}/${ep}` in next.files : undefined }) : [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-2">
      <SecurityDiffBlock base={base.parsed} next={next.parsed} />
      {lint.length > 0 && (
        <div className="rounded-md border border-line p-2">
          <div className="mb-1 text-xs font-semibold">Manifest lint ({next.label})</div>
          <FindingsList findings={lint} />
        </div>
      )}
      <MultiFileDiff base={base.files} next={next.files} oldLabel={base.label} newLabel={next.label} stripPrefix={prefix} />
    </div>
  );
}

export const toolDiffRenderer: DiffRenderer = (base, next) => <ToolDiff base={base} next={next} />;

export const plainDiffRenderer: DiffRenderer = (base, next) => (
  <div className="h-full overflow-auto p-2">
    <MultiFileDiff base={base.files} next={next.files} oldLabel={base.label} newLabel={next.label} />
  </div>
);
