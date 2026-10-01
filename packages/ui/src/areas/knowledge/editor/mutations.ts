/** Knowledge-specific write calls ([07] §5.3, [10] §3) with cache invalidation. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../../../lib/api';
import { qk } from '../../../lib/queries';

function useInvalidateNote(uid: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: qk.nodeRevisions(uid) });
    qc.invalidateQueries({ queryKey: qk.node(uid) });
    qc.invalidateQueries({ queryKey: qk.markdown(uid) });
  };
}

/** Restore a revision as a new forward revision (history is never rewritten). */
export function useRestoreRevision(uid: string) {
  const invalidate = useInvalidateNote(uid);
  return useMutation({
    mutationFn: (revision_id: number) => post(`/knowledge/${uid}/restore`, { revision_id }, { idempotencyKey: true }),
    onSuccess: invalidate,
  });
}

/** Revert one AI write to its `pre-ai-edit` revision (server computes the reverse delta). */
export function useRevertAiEdit(uid: string) {
  const invalidate = useInvalidateNote(uid);
  return useMutation({
    mutationFn: (pre_ai_edit_revision: number) => post(`/knowledge/${uid}/revert-ai-edit`, { pre_ai_edit_revision }, { idempotencyKey: true }),
    onSuccess: invalidate,
  });
}
