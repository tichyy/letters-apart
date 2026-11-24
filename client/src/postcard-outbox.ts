import { randomId } from './connection';
import type { ClientMessage, Side, Stamp, WriteRequest } from './protocol';

export interface Draft { title: string; body: string; stamp: Stamp | null }
export type Postcard = Omit<WriteRequest, 'type' | 'requestId'>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
interface PendingWrite { side: Side; message: WriteRequest }

const keys = {
  pending: 'letters-pending-write',
  body: 'letters-draft',
  title: 'letters-draft-title',
  stamp: 'letters-draft-stamp',
};

/**
 * A packed postcard, kept until the server answers its request ID. It survives a
 * reload and is sent again on every reconnect; the ID lets the server recognise a
 * repeat, so a retry can never write the card twice. Also keeps the unsent draft.
 */
export class PostcardOutbox {
  private pending?: PendingWrite;
  private side?: Side;

  constructor(private send: (message: ClientMessage) => boolean, private storage: Store = sessionStorage) {}

  /** A packed postcard is waiting for the server's answer. */
  get waiting(): boolean { return !!this.pending; }

  /** Where the photo editor keeps this home's draft photo. */
  get photoDraftKey(): string { return `letters-draft-photo-${this.side}`; }

  /** Connected as `side`: pick up a postcard packed before a reload, and send it again. */
  resume(side: Side): void {
    this.side = side;
    try {
      const pending = JSON.parse(this.storage.getItem(keys.pending) ?? 'null') as PendingWrite | null;
      this.pending = pending?.side === side ? pending : undefined;
    } catch {
      this.pending = undefined;
      this.storage.removeItem(keys.pending);
    }
    if (this.pending) this.send(this.pending.message);
  }

  /** Pack and send a postcard. False if it could not be sent; the draft stays. */
  submit(postcard: Postcard): boolean {
    if (!this.side) return false;
    const pending: PendingWrite = { side: this.side, message: { type: 'write', requestId: randomId(), ...postcard } };
    if (!this.send(pending.message)) return false;
    this.pending = pending;
    this.storage.setItem(keys.pending, JSON.stringify(pending));
    return true;
  }

  /**
   * The server wrote a postcard. True if it was ours (an answer without an ID is
   * taken as ours), which also discards the draft it was written from.
   */
  settle(requestId?: string): boolean {
    if (requestId && requestId !== this.pending?.message.requestId) return false;
    this.pending = undefined;
    for (const key of [keys.pending, keys.body, keys.title, keys.stamp, this.photoDraftKey]) {
      this.storage.removeItem(key);
    }
    return true;
  }

  /**
   * How a server error relates to the packed postcard:
   * 'stale': the answer to a request we no longer wait for, to ignore.
   * 'unrelated': a general error while ours is still waiting, which keeps waiting.
   * 'final': nothing waits any more; an error for ours drops it, keeping the draft.
   */
  fail(requestId?: string): 'stale' | 'unrelated' | 'final' {
    if (requestId && requestId !== this.pending?.message.requestId) return 'stale';
    if (!requestId) return this.pending ? 'unrelated' : 'final';
    this.pending = undefined;
    this.storage.removeItem(keys.pending);
    return 'final';
  }

  readDraft(): Draft {
    const stamp = this.storage.getItem(keys.stamp);
    return {
      title: this.storage.getItem(keys.title) ?? '',
      body: this.storage.getItem(keys.body) ?? '',
      stamp: stamp === '1' ? 1 : stamp === '2' ? 2 : stamp === '3' ? 3 : null,
    };
  }

  saveDraft({ title, body, stamp }: Draft): void {
    this.storage.setItem(keys.body, body);
    this.storage.setItem(keys.title, title);
    if (stamp) this.storage.setItem(keys.stamp, String(stamp));
    else this.storage.removeItem(keys.stamp);
  }
}
