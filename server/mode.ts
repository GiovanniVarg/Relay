import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, sep } from 'node:path';
import type { Agent, ChatMode, RunMode } from '../shared/types.js';
import { HttpError } from './security.js';

const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
const within = (parent: string, child: string) => { const rel = relative(fold(parent), fold(child)); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)); };
const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
/** Server-side workspace check (never trust the client). Returns the realpath. `dataDir` is Relay's own data dir, which work mode must never reach. */
export function validateWorkspace(path: unknown, dataDir: string, mode: 'work' | 'agent' = 'work'): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\u0000') || path.length > 1000 || !isAbsolute(path)) throw new HttpError(400, 'Workspace must be an absolute folder path');
  let resolved: string;
  try { resolved = realpathSync.native(path); if (!statSync(resolved).isDirectory()) throw new Error(); } catch { throw new HttpError(400, 'Workspace folder does not exist'); }
  if (parse(resolved).root === resolved) throw new HttpError(400, 'Workspace cannot be a drive or filesystem root');
  const data = real(dataDir);
  if (fold(real(homedir())) === fold(resolved)) {
    if (mode === 'agent' && !within(data, resolved)) return resolved;
    if (mode === 'agent') throw new HttpError(400, "Workspace cannot be Relay's data folder");
    throw new HttpError(400, 'Workspace cannot be your whole home folder in Work mode; choose a project folder');
  }
  if (within(data, resolved) || within(resolved, data)) throw new HttpError(400, "Workspace cannot contain or be inside Relay's data folder");
  return resolved;
}
// Auto mode needs a STRONG signal: a code-only verb, a work verb near a code noun, a git/npm command, a code fence or a file path. Common words (run, test, project, build) alone never trigger work.
const WORK = /\b(?:refactor|implement|debug|lint|compile|stack trace|codebase|repo|repository|(?:git|npm|pnpm|yarn)\s+[a-z]+|(?:fix|edit|create|write|delete|remove|add|update|modify|rename|open|read|install|run|build|commit)\b[^.\n?!]{0,40}?\b(?:files?|folders?|directory|directories|scripts?|functions?|class(?:es)?|components?|tests?|bugs?|errors?|modules?|branch(?:es)?|dependenc(?:y|ies)|packages?|endpoints?|methods?|config|lint|build))\b|```/i;
const FILE = /(?:^|[\s`'"(])(?:[\w.-]+[\\/])+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|css|html|yml|yaml|toml|sh|ps1|sql|c|cpp|h|cs|rb|php|txt|lock)\b/i;
/** Rules classifier for auto mode: only returns 'work' when the agent has a workspace. */
export function resolveMode(requested: ChatMode, agent: Pick<Agent, 'workspace'>, content: string): RunMode {
  if (requested === 'chat') return 'chat';
  if (requested === 'agent') return 'agent'; // Relay app actions do not require filesystem access.
  if (!agent.workspace) {
    if (requested === 'work') throw new HttpError(400, 'Work mode needs a workspace folder. Set one in the agent settings.');
    return 'chat';
  }
  if (requested === 'work') return 'work';
  return WORK.test(content) || FILE.test(content) ? 'work' : 'chat';
}
