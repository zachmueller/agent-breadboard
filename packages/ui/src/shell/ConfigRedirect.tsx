/** `/config/<uid>` ([10] §2): resolve a config definition's kind, then hand off to the owning editor. */
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useConfigDefinition } from '../lib/queries';
import { configEditorPath } from '../lib/paths';
import { ErrorState, Loading } from '../components/feedback';
import { JsonView } from '../components/JsonView';
import { PageBody, PageHeader } from '../components/PageHeader';

export function ConfigRedirect({ uid }: { uid: string }) {
  const q = useConfigDefinition(uid);
  const navigate = useNavigate();
  const def = q.data as { kind?: string; slug?: string; title?: string } | undefined;
  const target = def?.kind ? configEditorPath(def.kind, uid) : null;
  useEffect(() => {
    if (target) navigate({ to: target, replace: true });
  }, [target, navigate]);

  if (q.isPending || target) return <Loading label="Opening definition…" className="py-24" />;
  if (q.error) return <ErrorState error={q.error} title="Couldn't open this definition" onRetry={() => q.refetch()} className="py-24" />;
  // Kinds without a dedicated editor (presets, tenets, breadboard settings): show read-only.
  return (
    <PageBody>
      <PageHeader title={def?.title ?? def?.slug ?? uid} eyebrow={def?.kind ? `Config · ${def.kind}` : 'Config'} subtitle="This definition kind has no dedicated editor; showing the raw definition." />
      <JsonView value={q.data} />
    </PageBody>
  );
}
