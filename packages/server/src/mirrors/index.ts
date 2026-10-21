export { RepoMirrorsImpl, type RepoMirrorsDeps } from './service.js';
import { RepoMirrorsImpl, type RepoMirrorsDeps } from './service.js';

export function createRepoMirrors(deps: RepoMirrorsDeps): RepoMirrorsImpl {
  return new RepoMirrorsImpl(deps);
}
