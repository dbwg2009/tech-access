// In-memory fan-out for GET /api/panel/stream (Server-Sent Events). The panel page and the kiosk
// screen helper subscribe; the hub publishes taps, session changes, overview changes and screen
// wake / sleep.

export type PanelEventName = "tap" | "session" | "denied" | "overview" | "screen" | "confirm" | "captured" | "notice";

export interface PanelEvent {
  event: PanelEventName;
  data: unknown;
}

export class PanelStream {
  private readonly subs = new Set<(e: PanelEvent) => void>();

  subscribe(fn: (e: PanelEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(event: PanelEventName, data: unknown = {}): void {
    for (const fn of this.subs) {
      try {
        fn({ event, data });
      } catch {
        // a broken subscriber (closed tab) must not stop the others
      }
    }
  }

  get size(): number {
    return this.subs.size;
  }
}
