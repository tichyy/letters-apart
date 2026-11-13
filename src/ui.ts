import type { Direction, Side } from './protocol';

export class UI {
  direction: Direction = 0;
  jumpRequested = false;
  jumpHeld = false;
  private panel = document.createElement('dialog');
  private status: HTMLElement;
  private hint: HTMLButtonElement;
  private notice: HTMLElement;
  private toastTimer?: number;
  private held = new Set<Direction>();
  private submitting = false;

  constructor(
    private readonly send: (message: object) => boolean,
    private readonly join: (side: Side) => void,
    private readonly requestInteraction: () => void,
  ) {
    const root = document.querySelector<HTMLElement>('#interface')!;
    root.innerHTML = `
      <div class="hud"><span id="status" role="status"></span></div>
      <div id="notice" role="status" aria-live="polite"></div>
      <div class="bottom"><span class="keyboard-help">A / D or ← / → to walk · Space to jump · E to interact</span>
      <button id="interact" class="interaction" hidden></button></div>
      <div class="touch-controls" aria-label="Movement controls">
        <button data-direction="-1" aria-label="Walk left">←</button>
        <button data-direction="1" aria-label="Walk right">→</button>
        <button id="jump" aria-label="Jump">↑</button>
      </div>`;
    this.status = root.querySelector('#status')!;
    this.hint = root.querySelector('#interact')!;
    this.notice = root.querySelector('#notice')!;
    root.append(this.panel);
    this.hint.onclick = () => this.interact();
    const jump = root.querySelector<HTMLButtonElement>('#jump')!;
    jump.onpointerdown = event => {
      if (this.blocked) return;
      event.preventDefault();
      jump.setPointerCapture(event.pointerId);
      this.jumpRequested = true;
      this.jumpHeld = true;
    };
    const releaseJump = () => { this.jumpHeld = false; };
    jump.onpointerup = releaseJump;
    jump.onpointercancel = releaseJump;
    jump.onlostpointercapture = releaseJump;
    this.panel.addEventListener('close', () => { this.submitting = false; });
    this.panel.addEventListener('cancel', event => {
      if (this.submitting || this.panel.dataset.kind === 'home') event.preventDefault();
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-direction]')) {
      const direction = Number(button.dataset.direction) as Direction;
      button.onpointerdown = event => {
        if (this.blocked) return;
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        this.held.add(direction);
        this.updateDirection();
      };
      const release = () => { this.held.delete(direction); this.updateDirection(); };
      button.onpointerup = release;
      button.onpointercancel = release;
      button.onlostpointercapture = release;
    }
    window.addEventListener('blur', () => this.releaseControls());
  }

  get blocked(): boolean { return this.panel.open; }

  private updateDirection(): void {
    this.direction = this.held.size === 1 ? [...this.held][0] : 0;
  }

  releaseControls(): void {
    this.held.clear();
    this.direction = 0;
    this.jumpRequested = false;
    this.jumpHeld = false;
  }

  setStatus(text: string): void { this.status.textContent = text; }

  setHint(text: string): void {
    this.hint.hidden = !text;
    this.hint.textContent = matchMedia('(pointer: coarse)').matches ? text.replace(/^E · /, '') : text;
  }

  interact(): void {
    if (!this.blocked) this.requestInteraction();
  }

  toast(text: string): void {
    clearTimeout(this.toastTimer);
    this.notice.textContent = text;
    this.toastTimer = window.setTimeout(() => { this.notice.textContent = ''; }, 4500);
  }

  chooseHome(occupied = false): void {
    this.open('home', `
      <p class="eyebrow">LETTERS APART</p><h1>Which way is home?</h1>
      <p>${occupied ? 'That home has someone in it. Choose the other side.' : 'Two homes. A little distance. Something to say.'}</p>
      <div class="home-choices"><button data-home="left">← Left home</button><button data-home="right">Right home →</button></div>
      <p class="small">Each of you chooses a different home.</p>`);
    for (const button of this.panel.querySelectorAll<HTMLButtonElement>('[data-home]')) {
      button.onclick = () => {
        this.panel.close();
        this.join(button.dataset.home as Side);
      };
    }
  }

  compose(): void {
    this.open('compose', `
      <p class="eyebrow">AT HOME</p><h1>A postcard for you.</h1>
      <form><label for="message">What would you like to say?</label>
      <textarea id="message" name="message" maxlength="1000" rows="6" required placeholder="Dear you,"></textarea>
      <div class="form-footer"><span id="count" class="small">0 / 1,000</span><span><button type="button" class="quiet" id="cancel">Cancel</button><button type="submit">Put in backpack →</button></span></div>
      <p id="form-error" role="alert"></p></form>`);
    const form = this.panel.querySelector('form')!;
    const textarea = this.panel.querySelector('textarea')!;
    textarea.value = sessionStorage.getItem('letters-draft') ?? '';
    const count = this.panel.querySelector('#count')!;
    const update = () => {
      count.textContent = `${textarea.value.length} / 1,000`;
      sessionStorage.setItem('letters-draft', textarea.value);
    };
    update();
    textarea.oninput = update;
    this.panel.querySelector<HTMLButtonElement>('#cancel')!.onclick = () => this.panel.close();
    form.onsubmit = event => {
      event.preventDefault();
      if (this.submitting || !textarea.value.trim()) return;
      if (!this.send({ type: 'write', body: textarea.value.trim() })) {
        this.error('Connection lost. Your draft is saved; try again when connected.');
        return;
      }
      this.submitting = true;
      this.panel.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = true;
    };
    textarea.focus();
  }

  written(): void {
    sessionStorage.removeItem('letters-draft');
    this.panel.close();
    this.toast('Postcard packed. Deliver it to the other mailbox.');
  }

  read(body: string, date: string): void {
    this.open('postcard', `
      <p class="eyebrow">A POSTCARD FROM THE OTHER SIDE</p><h1>You’ve got mail.</h1>
      <p class="postcard-body"></p><div class="postcard-footer"><time></time><button>Keep it safe</button></div>`);
    this.panel.querySelector('.postcard-body')!.textContent = body;
    this.panel.querySelector('time')!.textContent = new Date(`${date.replace(' ', 'T')}Z`)
      .toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
    this.panel.querySelector('button')!.onclick = () => this.panel.close();
  }

  error(text: string): void {
    this.submitting = false;
    const submit = this.panel.querySelector<HTMLButtonElement>('[type="submit"]');
    if (submit) submit.disabled = false;
    const error = this.panel.querySelector('#form-error');
    if (this.panel.open && error) error.textContent = text;
    else this.toast(text);
  }

  disconnected(text: string): void {
    this.setStatus(text);
    if (this.submitting) this.error('Connection interrupted. Your draft is saved.');
  }

  private open(kind: string, html: string): void {
    this.releaseControls();
    if (this.panel.open) this.panel.close();
    this.panel.dataset.kind = kind;
    this.panel.innerHTML = html;
    this.panel.showModal();
  }
}
