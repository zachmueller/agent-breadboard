/**
 * @breadboard/sandbox-runtime — the in-container runtime contract for tool extensions ([06] §2.1, §7).
 * Tool code receives `(input, ctx)`; `ctx` exposes the closed set of Breadboard primitives, each of
 * which calls back into the Breadboard API with the execution's short-lived actor token.
 */
export * from './types.js';
export { createContext } from './context.js';
export { runToolProcess } from './runner.js';
