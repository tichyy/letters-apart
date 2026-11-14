import type { Direction, Side, Stamp } from './protocol';

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
    this.panel.addEventListener('click', event => {
      if (event.target === this.panel && !this.submitting && this.panel.dataset.kind !== 'home') {
        this.panel.close();
      }
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
    const savedStamp = sessionStorage.getItem('letters-draft-stamp');
    const stamp = savedStamp === '1' ? 1 : savedStamp === '2' ? 2 : savedStamp === '3' ? 3 : null;
    const form = this.postcard(sessionStorage.getItem('letters-draft') ?? '', stamp, true);
    const textarea = form.querySelector('textarea')!;
    const pack = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const reset = form.querySelector<HTMLButtonElement>('[type="reset"]')!;
    const preview = form.querySelector<HTMLElement>('.postcard-stamp')!;
    const update = () => {
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      sessionStorage.setItem('letters-draft', textarea.value);
      if (selected) {
        preview.style.backgroundImage = `url('/ui/stamp${selected.value}.png')`;
        preview.setAttribute('aria-label', `Stamp ${selected.value}`);
        preview.hidden = false;
        sessionStorage.setItem('letters-draft-stamp', selected.value);
      } else {
        preview.hidden = true;
        preview.style.backgroundImage = '';
        sessionStorage.removeItem('letters-draft-stamp');
      }
      pack.disabled = this.submitting || !textarea.value.trim() || !selected;
      reset.disabled = this.submitting;
    };
    update();
    form.oninput = update;
    form.onreset = event => {
      event.preventDefault();
      if (this.submitting) return;
      textarea.value = '';
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.checked = false;
      form.querySelector('#form-error')!.textContent = '';
      update();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      if (this.submitting || !textarea.value.trim() || !selected) return;
      if (!this.send({ type: 'write', body: textarea.value.trim(), stamp: Number(selected.value) })) {
        this.error('Connection lost. Your draft is saved; try again when connected.');
        return;
      }
      this.submitting = true;
      update();
    };
    if (!matchMedia('(pointer: coarse)').matches) textarea.focus();
  }

  written(): void {
    sessionStorage.removeItem('letters-draft');
    sessionStorage.removeItem('letters-draft-stamp');
    this.panel.close();
    this.toast('Postcard packed. Deliver it to the other mailbox.');
  }

  read(body: string, stamp: Stamp): void {
    this.postcard(body, stamp, false);
  }

  private postcard(body: string, stamp: Stamp | null, writing: boolean): HTMLFormElement {
    this.open(writing ? 'compose' : 'postcard', `
      <form class="postcard-editor" data-side="back">
        <div class="postcard-stage">
          <img class="postcard-art" src="/ui/postcard1.png" alt="Postcard" draggable="false">
          <div class="postcard-back">
            <textarea class="postcard-message" name="message" aria-label="Postcard message"
              maxlength="1000" required ${writing ? '' : 'readonly'}></textarea>
            <span class="postcard-stamp" role="img" aria-label="Stamp ${stamp}"
              ${stamp ? `style="background-image: url('/ui/stamp${stamp}.png')"` : 'hidden'}></span>
          </div>
          <button type="button" class="postcard-turn" aria-label="Turn postcard over" aria-pressed="false"></button>
          ${writing ? `<button type="reset" class="postcard-reset" aria-label="Reset postcard" title="Reset postcard"></button>
            <button type="submit" class="postcard-pack" aria-label="Put postcard in backpack" title="Put postcard in backpack" disabled></button>` : ''}
        </div>
        ${writing ? `<div class="postcard-stamps" role="group" aria-label="Choose a stamp">
          ${([1, 2, 3] as const).map(value => `<input type="radio" name="stamp" value="${value}"
            aria-label="Stamp ${value}" required ${value === stamp ? 'checked' : ''}
            style="background-image: url('/ui/stamp${value}.png')">`).join('')}
        </div><p id="form-error" role="alert"></p>` : ''}
      </form>`);
    const form = this.panel.querySelector('form')!;
    form.querySelector('textarea')!.value = body;
    const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
    turn.onclick = () => {
      const front = form.dataset.side !== 'front';
      form.dataset.side = front ? 'front' : 'back';
      form.querySelector<HTMLImageElement>('.postcard-art')!.src = `/ui/postcard${front ? 2 : 1}.png`;
      form.querySelector<HTMLElement>('.postcard-back')!.hidden = front;
      turn.setAttribute('aria-pressed', String(front));
    };
    for (const name of ['postcard2', 'button_rotate2', 'button_rotate3', 'button_send2', 'button_send3', 'button_reset2', 'button_reset3']) {
      const image = new Image();
      image.src = `/ui/${name}.png`;
    }
    return form;
  }

  error(text: string): void {
    this.submitting = false;
    const submit = this.panel.querySelector<HTMLButtonElement>('[type="submit"]');
    if (submit) submit.disabled = !this.panel.querySelector('textarea')!.value.trim()
      || !this.panel.querySelector('[name="stamp"]:checked');
    const reset = this.panel.querySelector<HTMLButtonElement>('[type="reset"]');
    if (reset) reset.disabled = false;
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
