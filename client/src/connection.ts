import type { Message, Side, UploadedPhoto } from './protocol';

export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

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

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    if (!this.ready || !this.side) throw new Error('Reconnect to the game to use photos.');
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
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new HttpError(response.status, typeof body?.detail === 'string' ? body.detail : 'The photo could not be loaded. Please try again.');
    }
    return response;
  }
}
