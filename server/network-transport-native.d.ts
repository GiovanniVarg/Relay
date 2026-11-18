/** Minimal supported surface for the pinned dependency, whose exports omit its type condition. */
declare module '@fails-components/webtransport' {
  export class Http3Server {
    constructor(options: Record<string, unknown>);
    readonly ready: Promise<void>;
    readonly closed: Promise<void>;
    setRequestCallback(callback: (args: { header: Record<string, unknown> }) => Promise<{ path: string; status: number }>): void;
    sessionStream(path: string): ReadableStream<unknown>;
    startServer(): void;
    stopServer(): void;
    address(): { host: string; port: number } | null;
  }
}
declare module '@fails-components/webtransport-transport-http3-quiche' {
  export const Http3WebTransportServer: (...args: unknown[]) => unknown;
}
