let socket = null;
let reconnectTimer = null;
const listeners = new Set();

export function onWsEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) fn(event);
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'subscribe', agentId: 'all' }));
    emit({ type: 'ws_connected' });
  };

  socket.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      emit(data);
    } catch {
      // ignore
    }
  };

  socket.onclose = () => {
    emit({ type: 'ws_disconnected' });
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  socket.onerror = () => socket?.close();
}

export function initWebSocket() {
  connect();
}
