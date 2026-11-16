// The hub's connection to Mosquitto. The hub must keep working with no broker: connect in the
// background, reconnect quietly, and refuse (not queue) commands while disconnected so a box can
// never open minutes late. Topic contract: docs/mqtt.md.
import mqtt, { type MqttClient } from "mqtt";

export interface Bus {
  connected(): boolean;
  /** Returns false (and sends nothing) when not connected. */
  publish(topic: string, payload: string, opts?: { retain?: boolean; qos?: 0 | 1 }): boolean;
  onMessage(fn: (topic: string, payload: string) => void): void;
  /** Called on every (re)connect, after subscriptions are in place. */
  onConnect(fn: () => void): void;
  close(): Promise<void>;
}

/** Subscriptions the hub needs (see docs/mqtt.md). */
export const HUB_SUBSCRIPTIONS = ["box/+/state", "box/+/heartbeat"];

export interface MqttBusOptions {
  url: string;
  username: string;
  password?: string;
  log?: (msg: string) => void;
}

export class MqttJsBus implements Bus {
  private readonly client: MqttClient;
  private readonly msgFns: ((t: string, p: string) => void)[] = [];
  private readonly connFns: (() => void)[] = [];
  private lastError = "";

  constructor(o: MqttBusOptions) {
    const log = o.log ?? ((m: string) => console.log(m));
    this.client = mqtt.connect(o.url, {
      username: o.username,
      password: o.password,
      clientId: "tech-access-hub",
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: 5_000,
      keepalive: 30,
      queueQoSZero: false,
      resubscribe: true,
    });
    this.client.on("connect", () => {
      this.lastError = "";
      log("mqtt: connected");
      this.client.subscribe(HUB_SUBSCRIPTIONS, { qos: 1 }, (err) => {
        if (err) log(`mqtt: subscribe failed: ${err.message}`);
        for (const f of this.connFns) safe(f);
      });
    });
    this.client.on("message", (topic, payload) => {
      for (const f of this.msgFns) safe(() => f(topic, payload.toString("utf8")));
    });
    // Quiet: log each distinct problem once, not every 5 s.
    this.client.on("error", (e) => {
      if (e.message !== this.lastError) log(`mqtt: ${e.message} (retrying every 5 s)`);
      this.lastError = e.message;
    });
    this.client.on("offline", () => {
      if (this.lastError !== "offline") log("mqtt: broker not reachable (retrying every 5 s)");
      this.lastError = this.lastError || "offline";
    });
  }

  connected(): boolean {
    return this.client.connected;
  }

  publish(topic: string, payload: string, opts: { retain?: boolean; qos?: 0 | 1 } = {}): boolean {
    if (!this.client.connected) return false;
    this.client.publish(topic, payload, { qos: opts.qos ?? 1, retain: opts.retain ?? false });
    return true;
  }

  onMessage(fn: (topic: string, payload: string) => void): void {
    this.msgFns.push(fn);
  }

  onConnect(fn: () => void): void {
    this.connFns.push(fn);
  }

  async close(): Promise<void> {
    await this.client.endAsync(true).catch(() => {});
  }
}

function safe(f: () => void): void {
  try {
    f();
  } catch (e) {
    console.error(`mqtt handler: ${(e as Error).message}`);
  }
}

/** In-memory bus for tests and for running the hub with no broker configured. */
export class FakeBus implements Bus {
  isConnected = true;
  readonly sent: { topic: string; payload: string; retain: boolean }[] = [];
  readonly retained = new Map<string, string>();
  private readonly msgFns: ((t: string, p: string) => void)[] = [];
  private readonly connFns: (() => void)[] = [];

  connected(): boolean {
    return this.isConnected;
  }

  publish(topic: string, payload: string, opts: { retain?: boolean } = {}): boolean {
    if (!this.isConnected) return false;
    this.sent.push({ topic, payload, retain: !!opts.retain });
    if (opts.retain) this.retained.set(topic, payload);
    return true;
  }

  onMessage(fn: (topic: string, payload: string) => void): void {
    this.msgFns.push(fn);
  }

  onConnect(fn: () => void): void {
    this.connFns.push(fn);
  }

  /** Test helper: a message arriving from a box. */
  deliver(topic: string, payload: unknown): void {
    const p = typeof payload === "string" ? payload : JSON.stringify(payload);
    for (const f of this.msgFns) f(topic, p);
  }

  /** Test helper: broker comes (back) up. */
  connect(): void {
    this.isConnected = true;
    for (const f of this.connFns) f();
  }

  async close(): Promise<void> {}
}
