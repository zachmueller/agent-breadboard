import { Coins } from 'lucide-react';
import { formatCost, formatTokens } from '../lib/format';
import { cn } from './cn';
import { Tooltip } from './Tooltip';

export interface CostInlineProps {
  usd: number | string | null | undefined;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Total including descendant sessions (shown in the tooltip, and as the value when `preferTotal`). */
  includingChildren?: number | null;
  preferTotal?: boolean;
  icon?: boolean;
  className?: string;
}

/** `$0.0123` with a tokens breakdown tooltip ([10] §5 cost visibility). */
export function CostInline({ usd, tokensIn, tokensOut, includingChildren, preferTotal, icon, className }: CostInlineProps) {
  const own = typeof usd === 'string' ? Number(usd) : usd;
  const shown = preferTotal && includingChildren !== null && includingChildren !== undefined ? includingChildren : own;
  const hasChildren = includingChildren !== null && includingChildren !== undefined && own !== null && own !== undefined && Math.abs(includingChildren - own) > 1e-9;
  const tip =
    tokensIn !== undefined || tokensOut !== undefined || hasChildren ? (
      <div className="flex flex-col gap-0.5 tabular">
        {(tokensIn !== undefined || tokensOut !== undefined) && (
          <span>
            {formatTokens(tokensIn ?? 0)} in · {formatTokens(tokensOut ?? 0)} out
          </span>
        )}
        {hasChildren && (
          <span>
            {formatCost(own)} own · {formatCost(includingChildren)} incl. sub-sessions
          </span>
        )}
      </div>
    ) : null;
  return (
    <Tooltip content={tip}>
      <span className={cn('inline-flex items-center gap-1 whitespace-nowrap font-mono text-[12px] tabular text-fg-muted', className)}>
        {icon && <Coins size={12} className="text-fg-subtle" aria-hidden />}
        {formatCost(shown)}
      </span>
    </Tooltip>
  );
}
