import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(config.url) || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid private bridge');
  const active = new Map<string, AbortController>();
  const source = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  const pending = new Set<Promise<void>>();
  source.on('line', line => {
    const task = (async () => {
      let message: any;
      try {
        if (line.length > 256 * 1024) throw new Error('Request too large');
        message = JSON.parse(line);
        if (message.method === 'notifications/cancelled') { active.get(JSON.stringify(message.params?.requestId))?.abort(); return; }
        if (message.id == null) return;
        const id = JSON.stringify(message.id);
        if (active.has(id)) throw new Error('Duplicate pending request');
        const controller = new AbortController(); active.set(id, controller);
        try {
          let result: unknown;
          if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'relay_app', version: '1.0.0' } };
          else if (message.method === 'ping') result = {};
          else {
            if (!['tools/list', 'tools/call'].includes(message.method)) throw new Error('Unsupported MCP method');
            const reply = await fetch(config.url, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, signal: controller.signal,
              body: JSON.stringify(message.method === 'tools/list' ? { operation: 'list' } : { operation: 'call', id: `mcp-${id}`, name: message.params?.name, args: message.params?.arguments ?? {} }) });
            if (!reply.ok) throw new Error('Relay tool call rejected');
            const body = await reply.json() as any;
            result = message.method === 'tools/list' ? { tools: body.tools } : { content: [{ type: 'text', text: JSON.stringify(body.value) }] };
          }
          if (!controller.signal.aborted) send({ jsonrpc: '2.0', id: message.id, result });
        } finally { active.delete(id); }
      } catch { if (message?.id != null) send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Relay app-tool request rejected or cancelled' } }); }
    })();
    pending.add(task); void task.finally(() => pending.delete(task));
  });
  await new Promise<void>(done => source.once('close', done));
  for (const controller of active.values()) controller.abort();
  await Promise.allSettled(pending);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.exitCode = 1; });
