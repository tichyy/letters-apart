import type { Message, Side, UploadedPhoto } from './protocol';

export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// How long a photo request waits for the game connection to come back.
const readyTimeout = 15000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class Connection {
  ready = false;
  side: Side | null = null;
  private socket?: WebSocket;
  private retry?: number;
  private failures = 0;
  private lastResync = -Infinity;
  private lastMessage = 0;
  private waiting: (() => void)[] = [];
  private readonly token: string;

  constructor(
    private readonly receive: (message: Message) => void,
    private readonly status: (text: string) => void,
  ) {
    this.token = sessionStorage.getItem('letters-token') ?? randomId();
    sessionStorage.setItem('letters-token', this.token);
    // A mobile browser may retain a dead socket after switching networks.
    window.setInterval(() => {
      if (this.ready && Date.now() - this.lastMessage > 5000 && this.side) {
        this.connect(this.side);
      }
    }, 2000);
    // Back from the background (e.g. the camera): if the socket went quiet, the server
    // has likely dropped it, so reconnect now rather than waiting for the check above.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.side && Date.now() - this.lastMessage > 1000) this.connect(this.side);
    });
  }

  connect(side: Side): void {
    clearTimeout(this.retry);
    this.side = side;
    this.ready = false;
    this.status('Connecting…');
    const previous = this.socket;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/ws/${side}`);
    this.socket = socket;
    previous?.close();

    // The token goes in the first message, not the URL, which server logs record.
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token: this.token }));

    socket.onmessage = event => {
      if (socket !== this.socket) return;
      this.lastMessage = Date.now();
      const message = JSON.parse(event.data) as Message;
      if (message.type === 'welcome') {
        this.ready = true;
        this.failures = 0;
        for (const resume of this.waiting.splice(0)) resume();
        sessionStorage.setItem('letters-side', side);
      }
      if (message.type === 'occupied') {
        this.side = null;
        sessionStorage.removeItem('letters-side');
      }
      this.receive(message);
    };
    socket.onclose = event => {
      if (socket !== this.socket) return;
      this.ready = false;
      if (event.code === 1008 && event.reason === 'Sign in to play.') {
        this.side = null;
        location.assign('/login');
        return;
      }
      if (event.code === 4001) {
        // Signed in elsewhere took this home over; reconnecting would take it back.
        this.side = null;
        this.receive({ type: 'replaced', side });
        return;
      }
      if (this.side) {
        this.status('Reconnecting…');
        // 4000: the server asked for a resync. Do the first one at once, but if it
        // keeps happening (a client bug), back off rather than reconnect in a tight
        // loop. Otherwise back off with jitter so a restarting server isn't hit by
        // both players in lockstep.
        const resync = event.code === 4000 && Date.now() - this.lastResync > 10000;
        if (event.code === 4000) this.lastResync = Date.now();
        const delay = resync ? 0
          : Math.min(15000, 1000 * 2 ** this.failures++) * (0.5 + Math.random() / 2);
        this.retry = window.setTimeout(() => this.connect(side), delay);
      }
    };
    socket.onerror = () => socket.close();
  }

  send(message: object): boolean {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async uploadPhoto(file: File, id: string, signal: AbortSignal): Promise<UploadedPhoto> {
    const response = await this.request('/api/images', {
      method: 'POST', body: file, signal, headers: { 'X-Upload-ID': id },
    });
    return response.json();
  }

  async readPhoto(id: string, signal: AbortSignal): Promise<Blob> {
    return (await this.request(`/api/images/${id}`, { signal })).blob();
  }

  async discardPhoto(id: string): Promise<void> {
    await this.request(`/api/images/${id}`, { method: 'DELETE' });
  }

  /** Resolves once the game connection is live, waiting for a reconnect if needed. */
  private whenReady(signal?: AbortSignal | null): Promise<void> {
    // An 'abort' listener never fires for a signal that is already aborted.
    if (signal?.aborted) return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.waiting = this.waiting.filter(waiter => waiter !== resume);
        if (error) reject(error); else resolve();
      };
      const resume = () => finish();
      const abort = () => finish(new DOMException('The request was aborted.', 'AbortError'));
      const timer = setTimeout(() => finish(new Error('Reconnect to the game to use photos.')), readyTimeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(resume);
    });
  }

  private async request(path: string, options: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.side) throw new Error('Reconnect to the game to use photos.');
    // Choosing a photo can open the camera and background the page; the connection
    // may still be coming back when the photo arrives.
    await this.whenReady(options.signal);
    if (!this.side) throw new Error('Reconnect to the game to use photos.');
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('X-Player-Side', this.side);
    let response: Response;
    try {
      response = await fetch(path, { ...options, headers, cache: 'no-store' });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new Error('Connection interrupted. Please try the photo again.');
    }
    if (response.status === 401 && retry && this.side) {
      // The server ended this tab's session while the page was away. Reconnect and
      // try once more; uploads carry an ID, so a retry can't save the photo twice.
      this.connect(this.side);
      return this.request(path, options, false);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new HttpError(response.status, typeof body?.detail === 'string' ? body.detail : 'The photo could not be loaded. Please try again.');
    }
    return response;
  }
}
