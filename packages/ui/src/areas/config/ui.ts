/**
 * Single seam for UI primitives + HTTP used by the config-plane editors. Points at the shell's
 * shared modules (`src/lib/api`, `src/lib/toast`, `src/components`) where a compatible export exists;
 * the remaining primitives (whose shell counterparts have different shapes) live in `_local/`.
 */
import { createElement } from 'react';
import { get, post, patch, del, type RequestOptions } from '../../lib/api';
import { pushToast } from '../../lib/toast';
import { Markdown, JsonView } from '../../components';

/** Path-only HTTP client (`/api/v1` prefix, bearer + cookies, ApiError with `.status`/`.code`). */
export const api = {
  get: <T = unknown>(path: string) => get<T>(path),
  post: <T = unknown>(path: string, body?: unknown, opts?: Pick<RequestOptions, 'headers' | 'idempotencyKey'>) => post<T>(path, body ?? {}, opts),
  patch: <T = unknown>(path: string, body?: unknown) => patch<T>(path, body ?? {}),
  del: <T = unknown>(path: string) => del<T>(path),
};
export { errorMessage } from '../../lib/api';
export { useLiveEvents, useLiveConnected, payloadSessionId } from '../../lib/live';
export { Button as Btn, ActorLabel, buttonClasses } from '../../components';

export {
  TextInput,
  SelectInput,
  TextAreaInput,
  Pill,
  Spin,
  TabBar,
  Modal,
  Confirm,
  SideDrawer,
  Empty,
  ErrorBox,
  Header,
  Field,
  Section,
  type Tone,
} from './_local/components';

export function Md({ source, className }: { source: string; className?: string }) {
  return createElement(Markdown, { source, className, size: 'sm' });
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  return createElement(JsonView, { value, className, defaultExpandDepth: 2, maxHeight: '24rem' });
}

/** Toasts go to the shell's store (rendered once by the shell `<Toaster/>`). */
export function notify(message: string, tone: 'ok' | 'danger' | 'info' = 'info') {
  pushToast({ kind: tone === 'ok' ? 'success' : tone === 'danger' ? 'error' : 'info', title: message });
}

/** The shell renders the toast host; kept so editor chrome needn't know. */
export function ToastHost() {
  return null;
}
