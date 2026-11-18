import {validAccountDescriptor,type AccountDescriptor} from '../../shared/accounts.js';
import type { ProviderAdapter, ProviderConnection, ProviderId, ProviderRequest, ProviderResult } from '../../shared/types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { CursorAdapter } from './cursor.js';
import { OpenCodeAdapter } from './opencode.js';
import { GuardedProviderAdapter } from './lifecycle.js';
export { reconcileProviderCall } from './lifecycle.js';

const REMOVED = 'This provider connection was removed. Choose OpenAI, Claude or Cursor.';
/** Historical Record compatibility only. No native module, profile, login or command is loaded. */
class RetiredProviderAdapter implements ProviderAdapter {
  constructor(readonly id: 'gemini' | 'grok') {}
  async inspect(): Promise<ProviderConnection> { return { id: this.id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [], inferenceAvailable: false, error: REMOVED }; }
  async login(): Promise<never> { throw new Error(REMOVED); }
  async stream(_request: ProviderRequest): Promise<ProviderResult> { throw new Error(REMOVED); }
  async close(): Promise<void> {}
}
export function createAdapters(dataDir: string, account?: AccountDescriptor): Record<ProviderId, ProviderAdapter> {
  if(account&&!validAccountDescriptor(account))throw new Error('Invalid isolated account descriptor');
  const guarded = (adapter: ProviderAdapter) => process.platform === 'win32' ? new GuardedProviderAdapter(dataDir, adapter, account?.providerId===adapter.id?{account}:{} ) : adapter;
  return { openai: guarded(new CodexAdapter(dataDir)), claude: guarded(new ClaudeAdapter(dataDir,account?.providerId==='claude'?{isolatedProfile:true}:{})), cursor: guarded(new CursorAdapter(dataDir)),opencode:guarded(new OpenCodeAdapter(dataDir)), gemini: new RetiredProviderAdapter('gemini'), grok: new RetiredProviderAdapter('grok') };
}
