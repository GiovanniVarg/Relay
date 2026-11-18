import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAdapter, type AcpIdentity, type AcpOptions, type AcpProfile } from './acp.js';
import type { Command } from './process.js';

const GROK_SHA256 = '9891863f48c0cd973930d1e54fb28b02adb10521b2704d0ba7a3c625c26bb94d';
export async function findGrokCommand(): Promise<Command | null> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return null;
  const base = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url));
  const file = join(base, '.data-provider-tools', 'grok', '1.0.67', 'grok.exe');
  try { if (createHash('sha256').update(await readFile(file)).digest('hex') !== GROK_SHA256) return null; return { file, args: [] }; } catch { return null; }
}
/** Opaque account binding; native token contents never leave this isolated profile or enter the UI. */
export async function grokIdentity(home: string): Promise<AcpIdentity | null> {
  try {
    const root = join(home, '.grok'), path = join(root, 'auth.json');
    const info = await stat(path); if (!info.isFile() || info.size < 2 || info.size > 128 * 1024) return null;
    const bytes = await readFile(path); JSON.parse(bytes.toString('utf8'));
    const saltPath = join(root, '.relay-account-binding');
    try { await writeFile(saltPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const salt = await readFile(saltPath); if (salt.length !== 32) return null;
    return { accountLabel: 'Grok subscription · ' + createHmac('sha256', salt).update(bytes).digest('hex').slice(0, 24), plan: '' };
  } catch { return null; }
}
const profile: AcpProfile = {
  id: 'grok', title: 'Grok', authMethods: ['cached_token'], command: findGrokCommand, identity: grokIdentity, loginArgs: ['login', '--oauth'], nativeAgent: true,
  async configure(home) {
    const root = join(home, '.grok'); await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'config.toml'), '[cli]\nauto_update = false\n[auth]\npreferred_method = "oidc"\n[models]\nmax_retries = 0\n[ui]\npermission_mode = "ask"\nremember_tool_approvals = false\n[permission]\nask = ["*"]\ndeny = ["WebSearch", "WebFetch"]\n', { mode: 0o600 });
    return { GROK_REMEMBER_TOOL_APPROVALS: '0', GROK_WRITE_FILE: '1' };
  },
  args(runDir, model, app) {
    return ['agent', '--no-leader', ...(model ? ['--model', model] : []), 'stdio', '--leader-socket', join(runDir, 'leader.sock')];
  },
  validate(initialize) {
    if (initialize._meta?.grokShell !== true || initialize._meta?.agentVersion !== '1.0.67')
      throw new Error('Relay currently verifies the official Grok 1.0.67 Windows ACP transport only');
  },
  async nativeAccount(client, initialize, home) {
    if (initialize._meta?.defaultAuthMethodId !== 'cached_token') throw new Error('Grok requires a cached native OAuth login; run the isolated login command');
    // Never call authenticate: the CLI can fall through to interactive browser login when its cache expires.
    const info = await client.call('_x.ai/auth/info', {});
    if (info.methodId !== 'cached_token' || info.userBlockedReason || !Array.isArray(info.teamBlockedReasons) || info.teamBlockedReasons.length)
      throw new Error('Grok native subscription authentication is unavailable or blocked; API-key authentication is disabled');
    const access = await client.call('_x.ai/auth/check_subscription', {}), meta = access.meta;
    if (access.authenticated !== true || !meta || meta.auth_mode !== 'Oidc' || meta.gate != null)
      throw new Error('Grok native OAuth entitlement could not be verified; no model prompt was sent');
    const email = typeof info.email === 'string' && info.email.length > 0 && info.email.length <= 180 && !/[\x00-\x1f]/.test(info.email) ? info.email : undefined;
    const fallback = await grokIdentity(home); if (!email && !fallback) throw new Error('Grok native account identity is unavailable');
    const team = typeof info.teamId === 'string' && info.teamId ? ' · team ' + info.teamId.slice(0, 80) : '';
    return { accountLabel: (email ?? fallback!.accountLabel) + team, plan: typeof meta.subscription_tier === 'string' ? meta.subscription_tier.slice(0, 80) : '' };
  },
};
const NATIVE_ONLY = 'Grok supports native Agent mode with a project folder and Relay approvals. Chat, Work and app-only Agent are unavailable.';
export class GrokAdapter extends AcpAdapter {
  constructor(dataDir: string, options: AcpOptions = {}) { super(dataDir, profile, options); }
  override async inspect() { const state = await super.inspect(); return { ...state, inferenceAvailable: true, nativeAgentOnly: true, error: state.error ? state.error + ' ' + NATIVE_ONLY : NATIVE_ONLY }; }
}
