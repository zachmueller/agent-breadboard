import { Dialog } from '../components/Dialog';
import { Kbd, modKey } from '../components/Kbd';
import { EXTRA_JUMPS, NAV_AREAS } from './nav';

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-[13px]">
      <span className="text-fg-muted">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

export function ShortcutsHelp({ open, onClose, isAdmin }: { open: boolean; onClose: () => void; isAdmin: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="grid gap-x-8 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">General</div>
          <Row keys={[modKey, 'K']} label="Search everything" />
          <Row keys={['/']} label="Search" />
          <Row keys={['e']} label="Open editor for this view" />
          <Row keys={['?']} label="Show shortcuts" />
          <Row keys={['esc']} label="Close dialog / drawer" />
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Go to</div>
          {NAV_AREAS.filter((a) => !a.adminOnly || isAdmin).map((a) => (
            <Row key={a.key} keys={['g', a.jump]} label={a.label} />
          ))}
          {EXTRA_JUMPS.map((x) => (
            <Row key={x.jump} keys={['g', x.jump]} label={x.label} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}
