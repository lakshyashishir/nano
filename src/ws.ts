import type { Env, WsEvent } from './types';

const HUB_ID = 'global';

export async function broadcast(env: Env, event: WsEvent): Promise<void> {
  const id = env.AGENT_SESSION.idFromName(HUB_ID);
  const stub = env.AGENT_SESSION.get(id);
  await stub.fetch('http://internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}
