import type { ClientMessage, Postcard, Side, Stamp } from './protocol';
import type { Connection } from './connection';
import { PhotoEditor } from './photo-editor';
import { PostcardOutbox } from './postcard-outbox';
import { postcardArt, stampArt } from './art';
import world from '../../world.json';

// Touch screens have no keyboard shortcuts to show.
const coarsePointer = () => matchMedia('(any-pointer: coarse)').matches;

interface LibraryPages {
  previous?: () => boolean;
  next?: () => boolean;
  remove: (id: number, index: number) => boolean;
}

export class UI {
  readonly gameplay: HTMLElement;
  private panel = document.createElement('dialog');
  private hint: HTMLButtonElement;
  private galleryButton: HTMLButtonElement;
  private dropButton: HTMLButtonElement;
  private dropTimer?: number;
  private notice: HTMLElement;
  private toastTimer?: number;
  private toastAnimation?: Animation;
  private noticeWorldPosition?: { x: number; y: number };
  /** Horizontal shift that kept the message on screen when it appeared, in CSS pixels. */
  private noticeShift?: number;
  private events = new EventTarget();
  private outbox: PostcardOutbox;
  private photo?: PhotoEditor;
  private side?: Side;
  private updateCompose?: () => void;
  private caretCleanup?: () => void;
  private scaleCleanup?: () => void;
  private writingCleanup?: () => void;
  private measureContext?: CanvasRenderingContext2D;
  private galleryFromEnd = false;
  private galleryFront = true;
  private galleryIndex = 0;
  private libraryReader?: (cards: Postcard[], start: number, pages: LibraryPages) => void;
  // The open compose dialog is locked while its postcard waits for the server.
  private get submitting(): boolean {
    return this.panel.open && this.panel.dataset.kind === 'compose' && this.outbox.waiting;
  }

  constructor(
    private readonly send: (message: ClientMessage) => boolean,
    private readonly join: (side: Side) => void,
    private readonly requestInteraction: (type?: 'interact' | 'gallery') => void,
    private readonly connection: Connection,
  ) {
    this.outbox = new PostcardOutbox(send);
    const root = document.querySelector<HTMLElement>('#interface')!;
    root.innerHTML = `
      <div id="notice" role="status" aria-live="polite"></div>
      <div id="gameplay">
        <div class="bottom">
          <button id="interact" class="interaction" hidden></button>
          <button id="gallery" class="interaction" hidden>Received postcards</button>
          <button id="drop" class="interaction" hidden></button>
        </div>
        <div class="touch-controls" aria-label="Movement controls">
          <div class="movement-controls">
            <button type="button" data-control="left" aria-label="Walk left">
              <span class="control-art" aria-hidden="true"></span>
            </button>
            <button type="button" data-control="right" aria-label="Walk right">
              <span class="control-art" aria-hidden="true"></span>
            </button>
          </div>
          <button type="button" data-control="jump" aria-label="Jump">
            <span class="control-art" aria-hidden="true"></span>
          </button>
        </div>
      </div>`;
    this.gameplay = root.querySelector('#gameplay')!;
    this.hint = root.querySelector('#interact')!;
    this.galleryButton = root.querySelector('#gallery')!;
    this.dropButton = root.querySelector('#drop')!;
    this.notice = root.querySelector('#notice')!;
    root.append(this.panel);
    this.hint.onclick = () => this.interact();
    this.galleryButton.textContent = coarsePointer() ? 'Received postcards' : 'F · Received postcards';
    this.galleryButton.onclick = () => this.openLibrary();
    this.dropButton.textContent = coarsePointer() ? 'Hold to drop postcard' : 'Hold Q · Drop postcard';
    this.dropButton.addEventListener('pointerdown', event => {
      if (event.button === 0) this.holdDrop(true);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.dropButton.addEventListener(type, () => this.holdDrop(false));
    }
    this.panel.addEventListener('close', () => {
      if (this.panel.open) return;
      this.releasePanel();
      this.syncGameplay();
    });
    this.panel.addEventListener('cancel', event => {
      if (this.submitting || this.panel.dataset.kind === 'home') event.preventDefault();
    });
    this.panel.addEventListener('click', event => {
      if (event.target === this.panel && !this.submitting && this.panel.dataset.kind !== 'home') {
        this.panel.close();
      }
    });
  }

  get blocked(): boolean { return this.panel.open; }

  /** The world is built: show it and its controls together. */
  revealWorld(): void {
    const loader = document.getElementById('loader');
    const show = () => { delete document.body.dataset.loading; };
    if (!loader) { show(); return; }
    // The dog greets every visit, even a cached one. Its toy is thrown in, and two
    // strides later the dog leaps to catch it (index.html times the flight). The
    // leap comes at least three strides after the dog starts running, and always at
    // the end of a stride so the run and jump frames join up.
    const run = loader.querySelector('.dog')?.getAnimations()[0];
    const stride = Number(run?.effect?.getTiming().duration) || 0;
    const played = Number(run?.currentTime) || 0;
    const lead = 2 * stride;
    const leap = stride ? Math.ceil(Math.max(3 * stride, played + lead) / stride - 1e-6) * stride : 0;
    setTimeout(() => {
      loader.dataset.leaving = '';
      loader.addEventListener('animationend', event => {
        if (event.target === loader) loader.remove();
      });
      // The world fades in once the dog has caught its toy, at the top of its leap.
      if (stride) setTimeout(show, lead + 250);
      else show();
    }, Math.max(0, leap - lead - played));
  }

  onDialogChange(listener: () => void): () => void {
    this.events.addEventListener('dialogchange', listener);
    return () => this.events.removeEventListener('dialogchange', listener);
  }

  private syncGameplay(): void {
    this.gameplay.hidden = this.blocked;
    this.events.dispatchEvent(new Event('dialogchange'));
  }

  setHint(text: string): void {
    this.hint.hidden = !text;
    this.hint.textContent = coarsePointer() ? text.replace(/^E · /, '') : text;
  }

  setGalleryAvailable(available: boolean): void { this.galleryButton.hidden = !available; }

  setDropAvailable(available: boolean): void {
    if (available === !this.dropButton.hidden) return;
    this.dropButton.hidden = !available;
    if (!available) this.holdDrop(false);
  }

  get noticeAnchor(): { x: number; y: number } | undefined {
    return this.notice.textContent ? this.noticeWorldPosition : undefined;
  }

  positionNotice(x: number, y: number): void {
    const bounds = this.notice.parentElement!.getBoundingClientRect();
    const halfWidth = this.notice.offsetWidth / 2;
    const height = this.notice.offsetHeight;
    const left = x - bounds.left;
    // Fit the message on screen where it appears, then keep that shift so it stays
    // with its object and slides off with it as the player walks away.
    this.noticeShift ??= Math.max(halfWidth + 16, Math.min(bounds.width - halfWidth - 16, left)) - left;
    this.notice.style.left = `${left + this.noticeShift}px`;
    this.notice.style.top = `${Math.max(height + 16, Math.min(bounds.height - 16, y - bounds.top))}px`;
  }

  openLibrary(): void {
    if (this.blocked || this.galleryButton.hidden) return;
    this.galleryFromEnd = false;
    this.galleryFront = true;
    this.galleryIndex = 0;
    this.requestInteraction('gallery');
  }

  interact(): void {
    if (!this.blocked) this.requestInteraction();
  }

  /** Dropping discards the card, so it takes a deliberate one-second hold. */
  holdDrop(held: boolean): void {
    clearTimeout(this.dropTimer);
    const holding = held && !this.blocked && !this.dropButton.hidden;
    this.dropButton.toggleAttribute('data-holding', holding);
    if (!holding) return;
    this.dropTimer = window.setTimeout(() => {
      this.dropButton.removeAttribute('data-holding');
      this.send({ type: 'drop' });
    }, 1000);
  }

  toast(text: string, anchor?: { x: number; y: number }): void {
    clearTimeout(this.toastTimer);
    const opacity = getComputedStyle(this.notice).opacity;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
    this.toastAnimation?.cancel();
    this.noticeWorldPosition = anchor ? { ...anchor } : undefined;
    this.noticeShift = undefined;
    if (!anchor) {
      this.notice.style.left = '';
      this.notice.style.top = '';
    }
    this.notice.textContent = text;
    this.toastAnimation = this.notice.animate([{ opacity }, { opacity: 1 }], {
      duration, easing: 'ease-out', fill: 'forwards',
    });
    this.toastTimer = window.setTimeout(() => {
      this.toastAnimation?.cancel();
      const fade = this.toastAnimation = this.notice.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration, easing: 'ease-in', fill: 'forwards',
      });
      void fade.finished.then(() => {
        if (this.toastAnimation === fade) this.notice.textContent = '';
      }).catch(() => {}); // A replacement message cancels the outgoing fade.
    }, 4500);
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

  replaced(side: Side): void {
    this.open('home', `
      <p class="eyebrow">LETTERS APART</p><h1>Playing somewhere else</h1>
      <p>Your home is open in another window or device.</p>
      <div class="home-choices"><button data-home>Play here instead</button></div>`);
    this.panel.querySelector<HTMLButtonElement>('[data-home]')!.onclick = () => {
      this.panel.close();
      this.join(side);
    };
  }

  compose(): void {
    const draft = this.outbox.readDraft();
    const form = this.postcard(draft.body, draft.stamp, true);
    const title = form.querySelector<HTMLInputElement>('.postcard-title')!;
    title.value = draft.title;
    this.fitPostcardText(form);
    const textarea = form.querySelector('textarea')!;
    for (const field of [title, textarea]) this.limitPostcardText(field);
    this.trackInsertion(form);
    this.zoomToWriting(form);
    const pack = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const reset = form.querySelector<HTMLButtonElement>('[type="reset"]')!;
    const preview = form.querySelector<HTMLElement>('.postcard-stamp')!;
    const update = () => {
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      const stamp = selected ? Number(selected.value) as Stamp : null;
      this.outbox.saveDraft({ title: title.value, body: textarea.value, stamp });
      if (stamp) {
        preview.style.backgroundImage = `url('${stampArt[stamp]}')`;
        preview.setAttribute('aria-label', `Stamp ${stamp}`);
        preview.hidden = false;
      } else {
        preview.hidden = true;
        preview.style.backgroundImage = '';
      }
      pack.disabled = this.submitting || !photo.ready || !textarea.value.trim() || !selected;
      reset.disabled = this.submitting;
      title.readOnly = textarea.readOnly = this.submitting;
      for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.disabled = this.submitting;
      photo.locked = this.submitting;
      photo.render();
    };
    const photo = this.photo = new PhotoEditor(form, this.connection, update, this.outbox.photoDraftKey);
    this.updateCompose = update;
    update();
    photo.restore();
    form.oninput = update;
    form.addEventListener('compositionend', update);
    form.onreset = event => {
      event.preventDefault();
      if (this.submitting) return;
      if (form.dataset.side === 'front') photo.reset();
      else {
        title.value = '';
        textarea.value = '';
        title.style.fontSize = textarea.style.fontSize = '';
        for (const input of form.querySelectorAll<HTMLInputElement>('[name="stamp"]')) input.checked = false;
      }
      form.querySelector('#form-error')!.textContent = '';
      update();
    };
    form.onsubmit = event => {
      event.preventDefault();
      const selected = form.querySelector<HTMLInputElement>('[name="stamp"]:checked');
      if (this.submitting || !photo.ready || !textarea.value.trim() || !selected || !this.side) return;
      const sent = this.outbox.submit({
        title: title.value.trim(), body: textarea.value.trim(),
        stamp: Number(selected.value) as Stamp, imageId: photo.photo?.id ?? null,
        crop: photo.photo ? { ...photo.photo.crop } : { x: 0.5, y: 0.5, zoom: 1 },
      });
      if (!sent) {
        this.error('Connection lost. Your draft is saved; try again when connected.');
        return;
      }
      update();
    };
    if (!matchMedia('(pointer: coarse)').matches) textarea.focus();
  }

  connected(side: Side): void {
    this.side = side;
    this.outbox.resume(side);
  }

  written(requestId?: string): void {
    if (!this.outbox.settle(requestId)) return;
    if (this.panel.dataset.kind === 'compose') this.panel.close();
    this.toast('Postcard packed. Deliver it to the other mailbox.',
      this.side ? { x: world.desks[this.side], y: 0 } : undefined);
  }

  gallery(cards: Postcard[], page: number, hasMore: boolean): void {
    const start = this.galleryFromEnd ? cards.length - 1 : Math.min(this.galleryIndex, cards.length - 1);
    this.galleryIndex = 0;
    this.galleryFromEnd = false;
    if (!cards.length) {
      if (this.libraryReader) this.panel.close();
      this.toast('Nothing to see here yet...',
        this.side ? { x: world.desks[this.side], y: 28 } : undefined);
      return;
    }
    const turnPage = (target: number, fromEnd: boolean): boolean => {
      if (!this.send({ type: 'gallery', page: target })) {
        this.toast('Connection lost. Reopen your library when connected.');
        return false;
      }
      this.galleryFromEnd = fromEnd;
      return true;
    };
    this.read(cards, start, {
      previous: page > 0 ? () => turnPage(page - 1, true) : undefined,
      next: hasMore ? () => turnPage(page + 1, false) : undefined,
      remove: (id, index) => {
        if (!this.send({ type: 'delete', id, page })) {
          this.toast('Connection lost. Please try again when connected.');
          return false;
        }
        this.galleryIndex = index;
        this.galleryFromEnd = cards.length === 1 && page > 0;
        return true;
      },
    });
  }

  read(cards: Postcard[], start = 0, pages?: LibraryPages): void {
    if (!cards[start]) return;
    if (pages && this.libraryReader) {
      this.libraryReader(cards, start, pages);
      return;
    }
    const form = this.postcard(cards[start].body, cards[start].stamp, false);
    const photo = this.photo = new PhotoEditor(form, this.connection, () => {});
    const previous = form.querySelector<HTMLButtonElement>('.postcard-previous')!;
    const next = form.querySelector<HTMLButtonElement>('.postcard-next')!;
    let remove: HTMLButtonElement | undefined;
    if (pages) {
      remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'postcard-delete';
      remove.setAttribute('aria-label', 'Delete postcard');
      remove.title = 'Delete postcard';
      form.querySelector('.postcard-stage')!.append(remove);
      remove.onclick = () => {
        if (!loading && current && pages?.remove(current.id, index)) {
          remove!.disabled = previous.disabled = next.disabled = true;
        }
      };
    }
    let index = -1;
    let current: Postcard | undefined;
    let loading = false;
    const markCurrent = () => !current || this.send({ type: 'read', id: current.id });
    const show = async (target: number) => {
      if (!this.panel.open || loading) return;
      if (!markCurrent()) {
        this.panel.close();
        this.error('Connection lost. Reopen your mailbox when connected.');
        return;
      }
      if (target < 0 || target >= cards.length) {
        const turnPage = target < 0 ? pages?.previous : pages?.next;
        if (turnPage?.()) previous.disabled = next.disabled = true;
        return;
      }
      const card = cards[target];
      if (!pages && form.dataset.side === 'front') form.querySelector<HTMLButtonElement>('.postcard-turn')!.click();
      loading = true;
      previous.disabled = next.disabled = true;
      if (remove) remove.disabled = true;
      const loaded = await photo.show(card.image ?? null, !!pages);
      loading = false;
      if (remove) remove.disabled = false;
      if (!this.panel.open || this.photo !== photo) return;
      if (pages && !loaded && current) {
        previous.disabled = index < 0 || (index === 0 && !pages.previous);
        next.disabled = index < 0 || (index === cards.length - 1 && !pages.next);
        this.toast('Could not load this postcard. Please try again.');
        return false;
      }
      index = target;
      current = card;
      form.classList.add('has-card');
      form.querySelector<HTMLInputElement>('.postcard-title')!.value = card.title;
      form.querySelector('textarea')!.value = card.body;
      this.fitPostcardText(form);
      const stamp = form.querySelector<HTMLElement>('.postcard-stamp')!;
      stamp.style.backgroundImage = `url('${stampArt[card.stamp]}')`;
      stamp.setAttribute('aria-label', `Stamp ${card.stamp}`);
      previous.disabled = index === 0 && !pages?.previous;
      next.disabled = index === cards.length - 1 && !pages?.next;
      return true;
    };
    previous.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    this.panel.onclose = () => {
      if (this.panel.open) return;
      if (this.panel.dataset.kind === 'postcard' && current) {
        markCurrent();
      }
      this.panel.onclose = null;
    };
    if (pages) {
      this.libraryReader = async (nextCards, nextStart, nextPages) => {
        const saved = { cards, pages, index };
        cards = nextCards;
        pages = nextPages;
        index = -1;
        if (!await show(nextStart) && this.panel.open && this.photo === photo) {
          ({ cards, pages, index } = saved);
          previous.disabled = index === 0 && !pages?.previous;
          next.disabled = index === cards.length - 1 && !pages?.next;
        }
      };
    }
    void show(start);
    if (pages) {
      const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
      turn.addEventListener('click', () => { this.galleryFront = form.dataset.side === 'front'; });
      if (this.galleryFront) turn.click();
    }
  }

  private postcard(body: string, stamp: Stamp | null, writing: boolean): HTMLFormElement {
    this.open(writing ? 'compose' : 'postcard', `
      <form class="postcard-editor" data-side="back">
        <div class="postcard-stage">
          <img class="postcard-art" src="${postcardArt.back}" alt="Postcard" draggable="false">
          <div class="postcard-photo" role="group" aria-label="Postcard photo" hidden>
            <img alt="Photo on the front of the postcard" draggable="false" hidden>
          </div>
          <div class="postcard-back">
            <input class="postcard-title" name="title" aria-label="Postcard title"
              maxlength="60" autocomplete="off" ${writing ? 'placeholder="A little title..."' : 'readonly'}>
            <textarea class="postcard-message" name="message" aria-label="Postcard message"
              maxlength="1000" required ${writing ? 'placeholder="Write a little note..."' : 'readonly'}></textarea>
            <span class="postcard-stamp" role="img" aria-label="Stamp ${stamp}"
              ${stamp ? `style="background-image: url('${stampArt[stamp]}')"` : 'hidden'}></span>
          </div>
          <button type="button" class="postcard-turn" aria-label="Turn postcard over" aria-pressed="false"></button>
          ${writing ? `<button type="reset" class="postcard-reset" aria-label="Reset message side" title="Reset message side"></button>
            <button type="submit" class="postcard-pack" aria-label="Put postcard in backpack" title="Put postcard in backpack" disabled></button>` : ''}
        </div>
        <input class="postcard-photo-input" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden ${writing ? '' : 'disabled'}>
        <p class="postcard-photo-status" role="status" aria-live="polite" hidden></p>
        ${writing ? `<div class="postcard-stamps" role="group" aria-label="Choose a stamp">
          ${([1, 2, 3] as const).map(value => `<input type="radio" name="stamp" value="${value}"
            aria-label="Stamp ${value}" required ${value === stamp ? 'checked' : ''}
            style="background-image: url('${stampArt[value]}')">`).join('')}
        </div><p id="form-error" role="alert"></p>` : `<div class="postcard-navigation" aria-label="Mailbox navigation">
          <button type="button" class="postcard-previous" aria-label="Previous postcard" disabled></button>
          <button type="button" class="postcard-next" aria-label="Next postcard" disabled></button>
        </div>`}
      </form>`);
    const form = this.panel.querySelector('form')!;
    this.scaleText(form);
    form.querySelector('textarea')!.value = body;
    if (!writing) this.readLarger(form);
    const turn = form.querySelector<HTMLButtonElement>('.postcard-turn')!;
    turn.onclick = () => {
      const front = form.dataset.side !== 'front';
      form.dataset.side = front ? 'front' : 'back';
      form.querySelector<HTMLImageElement>('.postcard-art')!.src = front ? postcardArt.front : postcardArt.back;
      form.querySelector<HTMLElement>('.postcard-back')!.hidden = front;
      form.querySelector<HTMLElement>('.postcard-photo')!.hidden = !front;
      form.querySelector<HTMLElement>('.postcard-photo-status')!.hidden = !front;
      const stamps = form.querySelector<HTMLElement>('.postcard-stamps');
      if (stamps) stamps.inert = front;
      const reset = form.querySelector<HTMLButtonElement>('.postcard-reset');
      if (reset) {
        reset.setAttribute('aria-label', front ? 'Reset photo side' : 'Reset message side');
        reset.title = front ? 'Reset photo side' : 'Reset message side';
      }
      this.photo?.render();
      if (!front) this.fitPostcardText(form);
      turn.setAttribute('aria-pressed', String(front));
    };
    return form;
  }

  /** Scale the text side, laid out at the desktop card's width, to the card on screen. */
  private scaleText(form: HTMLFormElement): void {
    const stage = form.querySelector<HTMLElement>('.postcard-stage')!;
    const back = form.querySelector<HTMLElement>('.postcard-back')!;
    const update = () => stage.style.setProperty('--postcard-scale', String(stage.clientWidth / back.offsetWidth || 1));
    const resize = new ResizeObserver(update);
    resize.observe(stage);
    update();
    this.scaleCleanup = () => resize.disconnect();
  }

  /**
   * Touch screens show the card small, so while a text field has the keyboard the
   * card widens until its writing area fills the dialog, and the dialog scrolls to
   * it. The card is laid out in percentages of its width and its text side rescales
   * with it (scaleText), so only the width changes. style.css sets the zoomed width.
   */
  private zoomToWriting(form: HTMLFormElement): void {
    if (!matchMedia('(pointer: coarse)').matches) return;
    // Left edge of the writing area, as a fraction of the card's width: the title and
    // message start at 7.5% and end at 46.2%, with a little paper either side.
    const writingLeft = 0.045;
    const margin = 8;
    const panel = this.panel;
    const fields = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.postcard-title, .postcard-message')];
    const stage = form.querySelector<HTMLElement>('.postcard-stage')!;
    const events = new AbortController();
    const options = { signal: events.signal };
    let frame = 0;
    const writingField = () => fields.find(field => field === document.activeElement && !field.readOnly);
    const scroll = () => {
      frame = 0;
      const field = writingField();
      if (!field || !panel.hasAttribute('data-writing')) return;
      const view = panel.getBoundingClientRect();
      const card = stage.getBoundingClientRect();
      panel.scrollLeft += card.left + card.width * writingLeft - view.left;
      // Show the field from its top, then keep the typing position in view below it.
      const box = field.getBoundingClientRect();
      let offset = box.top - view.top - margin;
      const caret = form.querySelector<HTMLElement>('.postcard-insertion');
      if (caret && !caret.hidden) {
        const mark = caret.getBoundingClientRect();
        offset = Math.max(offset, mark.bottom - view.bottom + margin);
      }
      panel.scrollTop += offset;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const update = () => {
      const writing = !!writingField();
      if (writing !== panel.hasAttribute('data-writing')) {
        panel.toggleAttribute('data-writing', writing);
        if (!writing) panel.scrollLeft = 0;
      }
      if (writing) schedule();
    };
    // Focus moving from the title to the message passes through the body: wait a
    // frame so the card doesn't zoom out and back in between them.
    form.addEventListener('focusin', update, options);
    // Opening the dialog focuses the title without a keyboard; the tap that brings
    // the keyboard up then gives no focus event.
    form.addEventListener('click', update, options);
    form.addEventListener('focusout', () => requestAnimationFrame(update), options);
    form.addEventListener('input', schedule, options);
    document.addEventListener('selectionchange', () => { if (writingField()) schedule(); }, options);
    // The keyboard slides in after focus and shrinks the visible area.
    window.visualViewport?.addEventListener('resize', schedule, options);
    this.writingCleanup = () => {
      events.abort();
      cancelAnimationFrame(frame);
      panel.removeAttribute('data-writing');
    };
  }

  private trackInsertion(form: HTMLFormElement): void {
    const back = form.querySelector<HTMLElement>('.postcard-back')!;
    const highlight = document.createElement('span');
    highlight.className = 'postcard-insertion';
    highlight.setAttribute('aria-hidden', 'true');
    const mirror = document.createElement('div');
    mirror.className = 'postcard-text-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    back.append(highlight, mirror);
    const events = new AbortController();
    let composing = false;
    const update = () => {
      const field = document.activeElement;
      highlight.hidden = true;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
          || !back.contains(field) || field.readOnly || composing
          || field.selectionStart === null || field.selectionStart !== field.selectionEnd) return;
      const style = getComputedStyle(field);
      const size = parseFloat(style.fontSize);
      Object.assign(mirror.style, {
        width: `${field.clientWidth}px`, fontFamily: style.fontFamily, fontSize: style.fontSize,
        fontWeight: style.fontWeight, fontStyle: style.fontStyle, lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        whiteSpace: field instanceof HTMLInputElement ? 'pre' : 'pre-wrap',
      });
      const index = field.selectionStart;
      const codePoint = field.value.codePointAt(index);
      const character = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
      // At a line's end, a zero-width space marks the spot: it fits on a full line,
      // where a visible character would wrap with the word before it onto the next.
      const atLineEnd = !character || character === '\n';
      const marker = document.createElement('span');
      marker.textContent = atLineEnd ? '\u200b' : character;
      const before = document.createTextNode(field.value.slice(0, index));
      mirror.replaceChildren(before, marker, document.createTextNode(field.value.slice(index + character.length)));
      // Measured on screen, where the text side is scaled; placed in its own layout.
      const scale = back.getBoundingClientRect().width / back.offsetWidth || 1;
      const origin = mirror.getBoundingClientRect();
      let cell: { left: number; top: number; width: number } = marker.getBoundingClientRect();
      const width = atLineEnd ? this.spaceWidth(style) : cell.width / scale;
      // Spaces typed at the end of the last line hang past its edge, and the spot after
      // them would wrap below the field: mark it at the end of that last line instead.
      const previous = field.value.slice(0, index).match(/[^]$/u)?.[0];
      if ((cell.top - origin.top) / scale + size > field.clientHeight + 1 && previous && previous !== '\n') {
        const range = document.createRange();
        range.setStart(before, index - previous.length);
        range.setEnd(before, index);
        const rects = range.getClientRects();
        const last = rects[rects.length - 1];
        if (last) cell = { left: last.right, top: last.top, width: cell.width };
      }
      // After the last letter of a full line the mark starts at the field's edge and
      // extends past it; pulling it inside would cover that letter.
      const x = Math.max(0, Math.min((cell.left - origin.left) / scale, field.clientWidth));
      const inset = field instanceof HTMLInputElement ? (field.clientHeight - size) / 2 : 0;
      Object.assign(highlight.style, {
        left: `${Math.round(field.offsetLeft + x - field.scrollLeft)}px`,
        top: `${Math.round(field.offsetTop + inset + (cell.top - origin.top) / scale + size * 0.3125 - field.scrollTop)}px`,
        width: `${Math.max(2, Math.round(width))}px`, height: `${Math.round(size * 0.5)}px`,
      });
      highlight.hidden = false;
    };
    for (const event of ['focusin', 'focusout', 'keyup', 'pointerup', 'select', 'scroll']) {
      form.addEventListener(event, update, { capture: true, signal: events.signal });
    }
    // After the field's own listener, which takes back text that no longer fits.
    form.addEventListener('input', update, { signal: events.signal });
    form.addEventListener('reset', () => queueMicrotask(update), { signal: events.signal });
    form.addEventListener('compositionstart', () => { composing = true; update(); }, { signal: events.signal });
    form.addEventListener('compositionend', () => { composing = false; update(); }, { signal: events.signal });
    document.addEventListener('selectionchange', update, { signal: events.signal });
    const resize = new ResizeObserver(update);
    resize.observe(form);
    this.caretCleanup = () => { events.abort(); resize.disconnect(); };
    update();
  }

  /**
   * Page zoom is blocked (a zoomed dialog left the game stuck zoomed in), and the
   * card's text shrinks to fit a small area. Tapping it shows it in large type.
   */
  private readLarger(form: HTMLFormElement): void {
    const title = form.querySelector<HTMLInputElement>('.postcard-title')!;
    const message = form.querySelector('textarea')!;
    const reader = document.createElement('div');
    reader.className = 'postcard-reader';
    reader.tabIndex = -1;
    reader.hidden = true;
    const heading = document.createElement('h2');
    const body = document.createElement('p');
    reader.append(heading, body);
    form.append(reader);
    const open = () => {
      heading.textContent = title.value;
      heading.hidden = !title.value;
      body.textContent = message.value;
      reader.hidden = false;
      reader.scrollTop = 0;
      reader.focus();
    };
    const close = () => { reader.hidden = true; };
    for (const field of [title, message] as HTMLElement[]) {
      field.title = 'Read larger';
      field.addEventListener('click', open);
      field.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); open(); }
      });
    }
    reader.addEventListener('click', close);
    // Escape closes the large text first, then the postcard.
    const cancel = (event: Event) => {
      if (!reader.isConnected) this.panel.removeEventListener('cancel', cancel);
      else if (!reader.hidden) { event.preventDefault(); close(); }
    };
    this.panel.addEventListener('cancel', cancel);
  }

  private spaceWidth(style: CSSStyleDeclaration): number {
    const context = (this.measureContext ??= document.createElement('canvas').getContext('2d')!);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return context.measureText('\u00a0').width;
  }

  private textOverflows(field: HTMLInputElement | HTMLTextAreaElement): boolean {
    return field.scrollHeight > field.clientHeight + 1 || field.scrollWidth > field.clientWidth + 1;
  }

  private fitPostcardText(form: HTMLFormElement): void {
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.postcard-title, .postcard-message')) {
      if (!field.clientWidth) continue;
      field.style.fontSize = '';
      // Keep older, longer postcards readable inside the same fixed area.
      for (let size = parseFloat(getComputedStyle(field).fontSize); this.textOverflows(field) && size > 6; size -= 0.75) {
        field.style.fontSize = `${size - 0.75}px`;
      }
      field.scrollTop = field.scrollLeft = 0;
    }
  }

  private limitPostcardText(field: HTMLInputElement | HTMLTextAreaElement): void {
    let value = field.value;
    let start = 0;
    let end = 0;
    field.onbeforeinput = event => {
      if (event.isComposing) return;
      value = field.value;
      start = field.selectionStart ?? 0;
      end = field.selectionEnd ?? start;
    };
    const limit = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      if (this.textOverflows(field)) {
        field.value = value;
        field.setSelectionRange(start, end);
      }
      value = field.value;
      field.scrollTop = field.scrollLeft = 0;
    };
    field.addEventListener('input', limit);
    field.addEventListener('compositionend', limit);
    // A word still being composed (as phone keyboards type) is only checked once it is
    // done: keep the field on its first lines meanwhile, never scrolled to a 9th.
    field.addEventListener('scroll', () => { field.scrollTop = field.scrollLeft = 0; });
  }

  error(text: string, requestId?: string): void {
    const outcome = this.outbox.fail(requestId);
    if (outcome === 'stale') return;
    if (outcome === 'unrelated') { this.toast(text); return; }
    // The compose dialog's update() recomputes its buttons, photo readiness included.
    this.updateCompose?.();
    const error = this.panel.querySelector('#form-error');
    if (this.panel.open && error) error.textContent = text;
    else this.toast(text);
  }

  disconnected(): void {
    if (this.submitting) this.toast('Connection interrupted. Your postcard will retry when connected.');
  }

  /** Let go of everything the current dialog's content set up. */
  private releasePanel(): void {
    this.caretCleanup?.();
    this.caretCleanup = undefined;
    this.scaleCleanup?.();
    this.scaleCleanup = undefined;
    this.writingCleanup?.();
    this.writingCleanup = undefined;
    this.libraryReader = undefined;
    this.photo?.dispose();
    this.photo = undefined;
    this.updateCompose = undefined;
  }

  private open(kind: string, html: string): void {
    this.releasePanel();
    if (this.panel.open) this.panel.close();
    this.panel.dataset.kind = kind;
    this.panel.innerHTML = html;
    this.panel.showModal();
    this.syncGameplay();
  }
}
