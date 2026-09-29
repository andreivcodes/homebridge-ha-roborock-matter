/**
 * Minimal Home Assistant WebSocket API client: auth, request/response,
 * `subscribe_entities` (compressed state stream), keepalive and reconnect.
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface HaLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface RequestOptions {
  /** called with the message id before sending (subscriptions: events can arrive before the result) */
  onId?: (id: number) => void;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface CompressedState {
  s?: string;
  a?: Record<string, unknown>;
}

interface CompressedDiff {
  '+'?: CompressedState;
  '-'?: { a?: string[] };
}

export class HaError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'HaError';
  }
}

/**
 * Events: `connected` (after auth, every (re)connect), `disconnected`,
 * `state` (HaState, for subscribed entities).
 */
export class HaClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly states = new Map<string, HaState>();
  private subscribedIds: string[] = [];
  private subscriptionId: number | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private _connected = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly log: HaLogger,
    private readonly requestTimeoutMs = 15000,
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  getState(entityId: string): HaState | undefined {
    return this.states.get(entityId);
  }

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.teardown(new HaError('client stopped'));
  }

  /** Adds entities to the `subscribe_entities` stream (resubscribes only when the set grows). */
  async watchEntities(entityIds: string[]): Promise<void> {
    const merged = [...new Set([...this.subscribedIds, ...entityIds])];
    if (merged.length === this.subscribedIds.length && this.subscriptionId !== null) {
      return;
    }
    this.subscribedIds = merged;
    if (this._connected) {
      await this.sendSubscribe();
    }
  }

  async callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
    target?: Record<string, unknown>,
    returnResponse = false,
  ): Promise<unknown> {
    const msg: Record<string, unknown> = { type: 'call_service', domain, service, service_data: serviceData };
    if (target) {
      msg.target = target;
    }
    if (returnResponse) {
      msg.return_response = true;
    }
    const result = await this.request(msg) as { response?: unknown } | null;
    return returnResponse ? result?.response : result;
  }

  request(payload: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    const ws = this.ws;
    if (!ws || !this._connected) {
      return Promise.reject(new HaError('Home Assistant is not connected', 'not_connected'));
    }
    const id = this.nextId++;
    options.onId?.(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaError(`Home Assistant request timed out: ${String(payload.type)}`, 'timeout'));
      }, options.timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  private open(): void {
    const wsUrl = this.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/websocket';
    this.log.debug(`Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
    this.ws = ws;

    ws.on('message', data => this.onMessage(ws, data.toString()));
    ws.on('error', err => this.log.debug(`WebSocket error: ${err.message}`));
    ws.on('close', () => {
      if (this.ws === ws) {
        this.teardown(new HaError('connection closed', 'closed'));
        this.scheduleReconnect();
      }
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        return;
      case 'auth_invalid':
        this.log.error(`Home Assistant rejected the access token: ${String(msg.message)}`);
        // Keep retrying slowly: the user may fix the token in HA without restarting Homebridge.
        this.reconnectDelay = 60000;
        ws.close();
        return;
      case 'auth_ok':
        this.onAuthenticated(String(msg.ha_version ?? 'unknown'));
        return;
      case 'result':
      case 'pong': {
        const p = this.pending.get(msg.id as number);
        if (!p) {
          return;
        }
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        if (msg.type === 'pong' || msg.success) {
          p.resolve(msg.result ?? null);
        } else {
          const e = (msg.error ?? {}) as { code?: string; message?: string };
          p.reject(new HaError(e.message ?? 'Home Assistant error', e.code));
        }
        return;
      }
      case 'event':
        if (msg.id === this.subscriptionId) {
          this.onEvent(msg.event as Record<string, unknown>);
        }
        return;
    }
  }

  private onAuthenticated(haVersion: string): void {
    this._connected = true;
    this.reconnectDelay = 1000;
    // The new subscription's snapshot is the truth; don't keep states from before the disconnect.
    this.states.clear();
    this.log.info(`Connected to Home Assistant ${haVersion}`);
    this.pingTimer = setInterval(() => {
      this.request({ type: 'ping' }).catch(() => {
        this.log.warn('Home Assistant ping failed, reconnecting');
        this.ws?.terminate();
      });
    }, 30000);
    const subscribe = this.subscribedIds.length > 0 ? this.sendSubscribe() : Promise.resolve();
    subscribe
      .catch(err => this.log.error(`Failed to subscribe to entities: ${(err as Error).message}`))
      .finally(() => this.emit('connected'));
  }

  private async sendSubscribe(): Promise<void> {
    const previous = this.subscriptionId;
    await this.request({ type: 'subscribe_entities', entity_ids: this.subscribedIds }, {
      onId: id => {
        this.subscriptionId = id;
      },
    });
    // Only unsubscribe on the same connection: subscriptions die with their socket.
    if (previous !== null) {
      this.request({ type: 'unsubscribe_events', subscription: previous }).catch(() => undefined);
    }
  }

  /**
   * Decodes the compressed `subscribe_entities` stream: a = add (full state),
   * c = change ('+' new state/attributes, '-' removed attribute keys), r = remove.
   * Inside '+', `c` is the context and lc/lu are timestamps, which this client ignores.
   */
  private onEvent(event: Record<string, unknown> | undefined): void {
    if (!event) {
      return;
    }
    const added = event.a as Record<string, CompressedState> | undefined;
    const changed = event.c as Record<string, CompressedDiff> | undefined;
    const removed = event.r as string[] | undefined;

    for (const [entityId, s] of Object.entries(added ?? {})) {
      this.setState({ entity_id: entityId, state: s.s ?? 'unknown', attributes: { ...(s.a ?? {}) } });
    }
    for (const [entityId, diff] of Object.entries(changed ?? {})) {
      const prev = this.states.get(entityId);
      if (!prev) {
        continue;
      }
      const attributes = { ...prev.attributes, ...(diff['+']?.a ?? {}) };
      for (const key of diff['-']?.a ?? []) {
        delete attributes[key];
      }
      this.setState({ entity_id: entityId, state: diff['+']?.s ?? prev.state, attributes });
    }
    for (const entityId of removed ?? []) {
      this.setState({ entity_id: entityId, state: 'unavailable', attributes: {} });
    }
  }

  private setState(state: HaState): void {
    this.states.set(state.entity_id, state);
    this.emit('state', state);
  }

  private teardown(reason: Error): void {
    const wasConnected = this._connected;
    this._connected = false;
    this.subscriptionId = null;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.removeAllListeners('close');
      ws.terminate();
    }
    if (wasConnected) {
      this.log.warn(`Disconnected from Home Assistant (${reason.message})`);
      this.emit('disconnected');
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
