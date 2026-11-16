// One fob held on the reader is one tap, not one per poll.
//
// The reader polls a few times a second. A UID counts as a new tap when it differs from the fob
// that is currently on the reader, or when the same fob comes back after being away for at least
// `releaseMs`. A single missed poll while a fob is held (RF glitch) is shorter than `releaseMs`,
// so it doesn't cause a second tap. Pure: the caller passes the time.

export class Debouncer {
  private present: string | null = null;
  private lastSeen = 0;

  constructor(private readonly releaseMs = 600) {}

  /** Call once per poll with the UID seen (or null). Returns the UID when it is a new tap. */
  seen(uid: string | null, nowMs: number): string | null {
    if (this.present !== null && nowMs - this.lastSeen >= this.releaseMs) this.present = null;
    if (uid === null) return null;
    const isNew = uid !== this.present;
    this.present = uid;
    this.lastSeen = nowMs;
    return isNew ? uid : null;
  }

  reset(): void {
    this.present = null;
  }
}
