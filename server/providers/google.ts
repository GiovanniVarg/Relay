import type { LoginResult, ProviderAdapter, ProviderConnection, ProviderEvent, ProviderRequest, ProviderResult } from '../../shared/types.js';

const GUIDANCE_URL = 'https://antigravity.google/docs/faq/';
const UNAVAILABLE = 'Google is unavailable in Relay. Consumer Gemini CLI access ended on June 18, 2026, and Antigravity does not support consumer subscription connections from third-party applications. No API fallback is enabled.';

/** Preserve the saved provider ID without treating legacy Gemini OAuth as a supported consumer connection. */
export class GoogleAccountAdapter implements ProviderAdapter {
  readonly id = 'gemini' as const;
  async inspect(): Promise<ProviderConnection> {
    return { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [], inferenceAvailable: false, error: UNAVAILABLE };
  }
  async login(): Promise<LoginResult> {
    return { url: GUIDANCE_URL, message: UNAVAILABLE + ' This link opens official product guidance, not a Relay sign-in flow.' };
  }
  async stream(_request: ProviderRequest, _emit: (event: ProviderEvent) => void, _signal: AbortSignal, _beforeDispatch?: () => void): Promise<ProviderResult> {
    throw new Error(UNAVAILABLE);
  }
  async close(): Promise<void> {}
}
