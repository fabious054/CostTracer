import { Directive, ElementRef, HostListener, inject, Input, OnDestroy } from '@angular/core';

let uid = 0;

/**
 * `[ctTooltip]="'text'"` — a small styled hover/focus hint box, appended to `<body>` and
 * positioned above the host (flips below if there's no room). Fast (≈120 ms), keyboard-friendly
 * (shows on focus, hides on Escape), and themed via the `.ct-tooltip` rule in `styles.scss`.
 * Replaces the native `title` (slow, unstyleable, invisible until you already hover).
 */
@Directive({
  selector: '[ctTooltip]',
  standalone: true,
})
export class TooltipDirective implements OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  @Input('ctTooltip') text = '';

  private box?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly id = `ct-tip-${++uid}`;

  @HostListener('mouseenter')
  @HostListener('focusin')
  protected show(): void {
    // mouseenter + focusin can both fire for one interaction — never stack a second timer,
    // or the one hide() can't see fires after the pointer is already gone (stuck tooltip).
    if (this.box || this.timer || !this.text.trim()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.build();
    }, 120);
  }

  @HostListener('mouseleave')
  @HostListener('focusout')
  @HostListener('keydown.escape')
  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected hide(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.box) {
      this.box.remove();
      this.box = undefined;
      this.host.removeAttribute('aria-describedby');
    }
  }

  private build(): void {
    document.getElementById(this.id)?.remove();
    const box = document.createElement('div');
    box.className = 'ct-tooltip';
    box.id = this.id;
    box.setAttribute('role', 'tooltip');
    box.textContent = this.text;
    // Park it at the origin, invisible, so its wrapped size can be read without a flash.
    box.style.left = '0';
    box.style.top = '0';
    box.style.visibility = 'hidden';
    document.body.appendChild(box);
    this.host.setAttribute('aria-describedby', this.id);
    this.box = box;

    const h = this.host.getBoundingClientRect();
    const bw = box.offsetWidth;
    const bh = box.offsetHeight;
    const gap = 4;
    const margin = 6;

    // Directly above the host, left edges aligned (clamped to the viewport). Flips below with
    // no room. No arrow — the shared left edge is what ties it to the element.
    let top = h.top - bh - gap;
    if (top < margin) top = h.bottom + gap;
    const left = Math.max(margin, Math.min(h.left, window.innerWidth - bw - margin));

    box.style.top = `${Math.round(top)}px`;
    box.style.left = `${Math.round(left)}px`;
    box.style.visibility = 'visible';
  }

  ngOnDestroy(): void {
    this.hide();
  }
}
