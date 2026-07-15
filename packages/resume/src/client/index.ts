/**
 * @sigx/resume/client
 *
 * Browser half of the resume pack. This entry is lazy-loaded by the
 * delegation loader on first interaction — it is never part of the initial
 * page payload.
 *
 * Currently: the QRL registry. The scope resume (`invoke`, facade signals,
 * upgrade-on-write) lands with the next #241 PR.
 */

export { __registerResumeQrl, resolveQrl, resetResumeQrls } from './qrl-registry';
export type { QrlLoader } from './qrl-registry';
