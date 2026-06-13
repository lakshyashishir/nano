import type { WsEvent } from './types';

export class AgentSession implements DurableObject {
  private sessions = new Set<WebSocket>();

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      if (request.method === 'POST') {
        const event = (await request.json()) as WsEvent;
        this.broadcast(event);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Expected WebSocket or POST broadcast', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptWebSocket(ws: WebSocket) {
    ws.accept();
    this.sessions.add(ws);

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { type: string };
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.addEventListener('close', () => {
      this.sessions.delete(ws);
    });

    ws.addEventListener('error', () => {
      this.sessions.delete(ws);
    });

    ws.send(JSON.stringify({ type: 'connected', message: 'Nano WebSocket ready' }));
  }

  private broadcast(event: WsEvent) {
    const payload = JSON.stringify(event);
    for (const ws of this.sessions) {
      try {
        ws.send(payload);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
