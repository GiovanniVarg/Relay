import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { AcpAdapter, findGeminiCommand, type AcpIdentity, type AcpOptions, type AcpProfile } from './acp.js';

export async function geminiIdentity(home: string): Promise<AcpIdentity | null> {
  try {
    const root = join(home, '.gemini'), credentials = join(root, 'oauth_creds.json');
    if ((await stat(credentials)).size > 128 * 1024) return null;
    const oauth = JSON.parse(await readFile(credentials, 'utf8'));
    if (typeof oauth.refresh_token !== 'string' || !oauth.refresh_token) return null;
    const saltPath = join(root, '.relay-account-binding');
    try { await writeFile(saltPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const salt = await readFile(saltPath); if (salt.length !== 32) return null;
    // The cached display email is not refreshed by the CLI on every OAuth authentication. Bind the approved credential instead.
    return { accountLabel: 'Gemini subscription · ' + createHmac('sha256', salt).update(oauth.refresh_token).digest('hex').slice(0, 24), plan: '' };
  } catch { return null; }
}
const profile: AcpProfile = {
  id: 'gemini', title: 'Gemini', authMethods: ['oauth-personal'], command: findGeminiCommand, identity: geminiIdentity, loginArgs: [],
  modelUnavailable(model) { return /flash[-_]lite/i.test(model) ? 'Flash Lite models are unavailable because the native CLI uses silent fallback to a different model on failure.' : undefined; },
  async configure(home, runDir, app, login = false) {
    const root = join(home, '.gemini'); await mkdir(root, { recursive: true, mode: 0o700 });
    const basic = { security: { auth: { selectedType: 'oauth-personal', useExternal: !login }, disableYoloMode: true, disableAlwaysAllow: true },
      tools: { core: [], discoveryCommand: '', callCommand: '' }, hooksConfig: { enabled: false }, mcpServers: {}, telemetry: { enabled: false }, experimental: { enableAgents: false, dynamicModelConfiguration: false },
      general: { enableAutoUpdate: false }, admin: { extensions: { enabled: false }, mcp: { enabled: true } } };
    await writeFile(join(root, 'settings.json'), JSON.stringify(basic), { mode: 0o600 });
    // Empty files at the fresh cwd stop native dotenv discovery for both trusted and untrusted workspaces.
    const cwd = join(runDir, 'workspace'); await mkdir(join(cwd, '.gemini'), { recursive: true, mode: 0o700 });
    await writeFile(join(cwd, '.env'), '', { mode: 0o600 }); await writeFile(join(cwd, '.gemini', '.env'), '', { mode: 0o600 });
    // Existing user-owned system files are rejected on Windows; absent private paths load {} without warnings.
    if (app) await writeFile(join(runDir, 'relay-app-policy.toml'), app.toolNames.map(name =>
      '[[rule]]\ntoolName = ' + JSON.stringify(name.replace(/^mcp__relay_app__/, '')) + '\nmcpName = "relay_app"\ndecision = "allow"\npriority = 900\n').join('\n'), { mode: 0o600 });
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(runDir, 'absent-system-settings.json'), GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(runDir, 'absent-system-defaults.json') };
  },
  args(runDir, model, app) { return ['--acp', ...(model ? ['--model', model] : []), '--allowed-mcp-server-names', app ? 'relay_app' : '__relay_no_mcp__', ...(app ? ['--policy', join(runDir, 'relay-app-policy.toml')] : [])]; },
  validate(initialize) {
    if (initialize.agentInfo?.name !== 'gemini-cli' || initialize.agentInfo?.version !== '0.62.0')
      throw new Error('Relay currently verifies native tool isolation only for Gemini CLI 0.62.0; update the integration before using another version');
  },
};
export class GeminiAdapter extends AcpAdapter { constructor(dataDir: string, options: AcpOptions = {}) { super(dataDir, profile, options); } }
