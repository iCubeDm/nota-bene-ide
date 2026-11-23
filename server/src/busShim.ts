// `nota-bene mcp --url <endpoint>` (epic 383 2f): the agent bus for an agent that speaks MCP over stdio only. It relays
// every message between its stdin/stdout and the server's Streamable HTTP endpoint, with the bearer from
// NOTA_BENE_BUS_BEARER (never on the command line, which other users of the computer can read).
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function busShimMain(argv: string[]): Promise<number> {
  const i = argv.indexOf('--url');
  const url = i >= 0 ? argv[i + 1] : undefined;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/a\/[a-z]+-[a-z2-7]{6}\/mcp$/.test(url)) {
    process.stderr.write('usage: nota-bene mcp --url http://127.0.0.1:<port>/a/<agent>/mcp\n');
    return 2;
  }
  const bearer = process.env.NOTA_BENE_BUS_BEARER;
  const remote = new StreamableHTTPClientTransport(new URL(url), bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : {});
  const local = new StdioServerTransport();
  local.onmessage = (m) => void remote.send(m).catch((e: unknown) => process.stderr.write(`nota-bene mcp: ${String(e)}\n`));
  remote.onmessage = (m) => void local.send(m);
  const done = new Promise<number>((resolve) => {
    local.onclose = () => resolve(0);
    remote.onerror = (e) => process.stderr.write(`nota-bene mcp: ${e.message}\n`);
  });
  await remote.start();
  await local.start();
  const code = await done;
  await remote.close().catch(() => {});
  return code;
}
