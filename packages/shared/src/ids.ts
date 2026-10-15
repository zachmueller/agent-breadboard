import { mintUid, isUid } from './uid.js';

/** Prefixed identifiers: `ses_` sessions, `trn_` turns, `nir_` need-input requests, `evr_` eval runs, `prp_` config proposals, `tok_` service tokens, `ptk_` personal access tokens. */
export type IdPrefix = 'ses' | 'trn' | 'nir' | 'evr' | 'prp' | 'tok' | 'ptk' | 'cap' | 'exe' | 'whk' | 'con';

export function mintId(prefix: IdPrefix): string {
  return `${prefix}_${mintUid()}`;
}

export function isPrefixedId(value: unknown, prefix: IdPrefix): value is string {
  return typeof value === 'string' && value.startsWith(prefix + '_') && isUid(value.slice(prefix.length + 1));
}

export const mintSessionId = () => mintId('ses');
export const mintTurnId = () => mintId('trn');
export const mintRequestId = () => mintId('nir');
export const mintEvalRunId = () => mintId('evr');
export const mintProposalId = () => mintId('prp');
