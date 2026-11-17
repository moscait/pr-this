import type { WebviewMessage } from '../../src/shared/types';

interface VsCodeApi {
  postMessage(m: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('[post]', m), getState: () => undefined, setState: () => undefined };

export const send = (m: WebviewMessage) => api.postMessage(m);
export const persisted = api;
