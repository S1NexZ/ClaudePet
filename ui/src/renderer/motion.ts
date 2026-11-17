import { gsap } from 'gsap';

/**
 * All hover / state motion of the pet UI, driven by GSAP (core only: transforms, opacity and CSS variables, so it stays on the compositor).
 * Each reveal is a paused timeline that is played forwards on "awake" and reversed on rest, so an interrupted move turns around from where it is
 * instead of jumping. With prefers-reduced-motion everything is applied instantly.
 */
export interface MotionParts { sprite: HTMLElement; dockPill: HTMLElement; chip: HTMLElement }

/**
 * GSAP's ticker: 60 Hz while something really moves (hover reveals, panels, the state "pop"); 15 Hz when the only running tween is the
 * stepped breathing (~7 visible changes a second, placed by time, so it looks the same). Every motion start calls boost() first.
 */
let fpsNow = 0;
const setFps = (f: number) => { if (f !== fpsNow) { fpsNow = f; gsap.ticker.fps(f); } };
export const boost = () => setFps(60);
let idleTween: gsap.core.Tween | null = null;
setInterval(() => {
  const busy = gsap.globalTimeline.getChildren(true, true, true).some((t) => t !== idleTween && t.isActive());
  setFps(busy ? 60 : 15);
}, 500);

export function createMotion(p: MotionParts, reduce: boolean) {
  boost(); // never above 60: on 144 Hz displays GSAP would otherwise re-style everything 144 times a second
  const dockButtons = Array.from(p.dockPill.querySelectorAll<HTMLElement>('button'));
  const word = p.chip.querySelector<HTMLElement>('#label-t')!;
  const dot = p.chip.querySelector<HTMLElement>('#dot')!;
  const speed = reduce ? 1000 : 1;
  const EASE = 'power3.out';

  // ---- the button rail: the three round buttons slide out sideways from behind the pet, one after another ----
  const dock = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .fromTo(dockButtons, { opacity: 0, x: -18, scale: 0.5 }, { opacity: 1, x: 0, scale: 1, duration: 0.34, stagger: 0.05, ease: 'back.out(1.6)' }, 0);
  dock.timeScale(speed).progress(0);

  // ---- the status island: always visible (the status dot inside the limit ring + one word), never changes its size; a click unfolds the session name ----
  const detail = p.chip.querySelector<HTMLElement>('#detail')!;
  gsap.set(detail, { maxWidth: 0, marginLeft: -8, autoAlpha: 0 });
  const more = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .to(detail, { maxWidth: 260, marginLeft: 0, duration: 0.38 }, 0)
    .to(detail, { autoAlpha: 1, duration: 0.28 }, 0.08);
  more.timeScale(speed).progress(0);

  const drive = (tl: gsap.core.Timeline, on: boolean, outSpeed = 1.5) => {
    boost();
    if (on) { if (tl.reversed() || tl.progress() === 0 || !tl.isActive()) { tl.timeScale(speed); tl.play(); } }
    else { tl.timeScale(speed * outSpeed); tl.reverse(); }
  };
  let awakeNow = false, moreNow = false;

  // ---- the pet itself: a calm pet breathes; a state change gives it a soft squash ----
  let popping = false;
  const breath = idleTween = gsap.to(p.sprite, { y: -1.5, scaleX: 1.012, scaleY: 1.02, duration: 1.8, ease: 'steps(12)', yoyo: true, repeat: -1, paused: true }); // stepped: ~7 visible changes a second instead of a repaint on every frame (the idle GPU cost)
  let breathing = false;
  const settle = () => { boost(); gsap.to(p.sprite, { y: 0, scaleX: 1, scaleY: 1, duration: 0.35, ease: 'power2.out', overwrite: 'auto' }); };

  // the status dot glows softly while Claude works (a CSS animation of the glow's opacity: no per-frame JS or repaint)
  let pulsing = false;

  return {
    /** the dot pulses while Claude is busy (any state but ready / done / asleep) */
    setPulse(on: boolean) {
      if (reduce) on = false;
      if (on === pulsing) return;
      pulsing = on;
      dot.classList.toggle('glowing', on);
    },
    /** the hover state: pill + chip */
    setAwake(on: boolean) {
      if (on === awakeNow) return;
      awakeNow = on;
      drive(dock, on, 1.8);
    },
    /** the session name next to the status word (a click on the chip) */
    setDetail(on: boolean) { if (on !== moreNow) { moreNow = on; drive(more, on, 1.4); } },
    /** the status word rolls up and the new one rolls in from below; the island's width follows the word (right edge only, the ring stays put) */
    setWord(text: string) {
      if (word.textContent === text) return;
      if (reduce || !word.textContent) { word.textContent = text; return; }
      boost();
      gsap.timeline({ defaults: { overwrite: 'auto' } })
        .to(word, { y: -9, autoAlpha: 0, duration: 0.13, ease: 'power2.in' })
        .call(() => {
          const from = p.chip.offsetWidth;
          word.textContent = text;
          const to = p.chip.offsetWidth;
          if (from !== to) gsap.fromTo(p.chip, { width: from }, { width: to, duration: 0.3, ease: 'power3.out', clearProps: 'width' });
        })
        .fromTo(word, { y: 9, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.24, ease: 'power3.out' });
    },
    setBreathing(on: boolean) {
      if (reduce || popping) on = false;
      if (on === breathing) return;
      breathing = on;
      if (on) { breath.play(); } else { breath.pause(); settle(); }
    },
    pop() {
      if (reduce) return;
      boost();
      popping = true; breathing = false; breath.pause();
      gsap.timeline({ onComplete: () => { popping = false; } })
        .to(p.sprite, { scaleX: 1.045, scaleY: 0.955, y: 0, duration: 0.12, ease: 'power2.out', overwrite: true })
        .to(p.sprite, { scaleX: 0.985, scaleY: 1.02, duration: 0.12, ease: 'sine.inOut' })
        .to(p.sprite, { scaleX: 1, scaleY: 1, duration: 0.14, ease: 'power2.out' });
    },
  };
}

/**
 * Panels that slide in from the pet and fold back into it. Instead of touching every place that toggles `hidden`, the property is wrapped:
 * showing plays the intro, hiding plays the outro and only then really hides (so the window shrinks after the animation, never before).
 */
export function animatePanels(els: Array<HTMLElement | null>, reduce: boolean): void {
  const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden')!;
  for (const el of els) {
    if (!el) continue;
    let leaving = false;
    const real = (v: boolean) => proto.set!.call(el, v);
    Object.defineProperty(el, 'hidden', {
      configurable: true,
      get: () => proto.get!.call(el) as boolean,
      set(v: boolean) {
        const cur = proto.get!.call(el) as boolean;
        if (reduce) { real(!!v); return; }
        boost();
        if (!v) {
          if (!cur && !leaving) return; // already shown
          leaving = false; gsap.killTweensOf(el); real(false);
          gsap.fromTo(el, { opacity: 0, y: -14, scale: 0.97, transformOrigin: '50% 0' }, { opacity: 1, y: 0, scale: 1, duration: 0.38, delay: 0.06, ease: 'power3.out', clearProps: 'opacity,transform' });
        } else {
          if (cur || leaving) return; // already hidden / on the way out
          leaving = true; gsap.killTweensOf(el);
          gsap.to(el, { opacity: 0, y: -10, scale: 0.97, transformOrigin: '50% 0', duration: 0.2, ease: 'power2.in', onComplete: () => { leaving = false; real(true); gsap.set(el, { clearProps: 'opacity,transform' }); } });
        }
      },
    });
  }
}
