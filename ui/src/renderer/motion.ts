import { gsap } from 'gsap';

/**
 * All hover / state motion of the pet UI, driven by GSAP (core only: transforms, opacity and CSS variables, so it stays on the compositor).
 * Each reveal is a paused timeline that is played forwards on "awake" and reversed on rest, so an interrupted move turns around from where it is
 * instead of jumping. With prefers-reduced-motion everything is applied instantly.
 */
export interface MotionParts { sprite: HTMLElement; dockPill: HTMLElement; chip: HTMLElement; ring: HTMLElement }

export function createMotion(p: MotionParts, reduce: boolean) {
  const dockButtons = Array.from(p.dockPill.querySelectorAll<HTMLElement>('button, .sep'));
  const label = p.chip.querySelector<HTMLElement>('#label')!;
  const detail = p.chip.querySelector<HTMLElement>('#detail')!;
  const ringText = p.ring.querySelector<HTMLElement>('#usage-ring-text')!;
  const speed = reduce ? 1000 : 1;
  const EASE = 'power3.out';

  // ---- the button pill: a dark shadow under the feet grows into the pill, the icons rise out of it ----
  gsap.set(p.dockPill, { transformOrigin: '50% 0' });
  const dock = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .fromTo(p.dockPill, { scaleX: 0.36, scaleY: 0.16, y: 2, opacity: 0.55 }, { scaleX: 1, scaleY: 1, y: 0, opacity: 1, duration: 0.45, ease: 'back.out(1.25)' }, 0)
    .fromTo(dockButtons, { opacity: 0, y: -10, scale: 0.5 }, { opacity: 1, y: 0, scale: 1, duration: 0.32, stagger: 0.045, ease: 'back.out(1.6)' }, 0.1);
  dock.timeScale(speed).progress(0);

  // ---- the status chip: a dot and a word near the feet; hovering lowers it and unfolds the glass pill and the details ----
  gsap.set(p.chip, { y: -47, '--bgo': 0 });
  const dot = p.chip.querySelector<HTMLElement>('#dot')!;
  gsap.set(label, { maxWidth: 0, marginLeft: -8, autoAlpha: 0 });
  gsap.set(detail, { maxWidth: 0, marginLeft: -8, autoAlpha: 0 });
  gsap.set(dot, { scale: 1.3 });
  const chip = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .to(p.chip, { y: 0, '--bgo': 1, duration: 0.42 }, 0)
    .to(dot, { scale: 1, duration: 0.4 }, 0)
    .to(label, { maxWidth: 220, marginLeft: 0, duration: 0.4 }, 0.02)
    .to(label, { autoAlpha: 1, duration: 0.3 }, 0.1)
    .to(detail, { maxWidth: 260, marginLeft: 0, duration: 0.42 }, 0.08)
    .to(detail, { autoAlpha: 1, duration: 0.3 }, 0.16);
  chip.timeScale(speed).progress(0);

  // ---- the usage ring: a small quiet arc by the pet; it grows and shows its number when awake ----
  gsap.set(p.ring, { scale: 0.7, opacity: 1, transformOrigin: '50% 50%' });
  gsap.set(ringText, { opacity: 0 });
  const ring = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .to(p.ring, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(1.4)' }, 0)
    .to(ringText, { opacity: 1, duration: 0.25 }, 0.1);
  ring.timeScale(speed).progress(0);

  const drive = (tl: gsap.core.Timeline, on: boolean, outSpeed = 1.5) => {
    if (on) { if (tl.reversed() || tl.progress() === 0 || !tl.isActive()) { tl.timeScale(speed); tl.play(); } }
    else { tl.timeScale(speed * outSpeed); tl.reverse(); }
  };
  let awakeNow = false, ringNow = false;

  // ---- the pet itself: a calm pet breathes; a state change gives it a soft squash ----
  let popping = false;
  const breath = gsap.to(p.sprite, { y: -1.5, scaleX: 1.012, scaleY: 1.02, duration: 1.8, ease: 'steps(12)', yoyo: true, repeat: -1, paused: true }); // stepped: ~7 visible changes a second instead of a repaint on every frame (the idle GPU cost)
  let breathing = false;
  const settle = () => { gsap.to(p.sprite, { y: 0, scaleX: 1, scaleY: 1, duration: 0.35, ease: 'power2.out', overwrite: 'auto' }); };

  // the status dot glows softly while Claude works
  const glow = gsap.to(dot, { '--gr': '12px', duration: 0.9, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true });
  let pulsing = false;

  return {
    /** the dot pulses while Claude is busy (any state but ready / done / asleep) */
    setPulse(on: boolean) {
      if (reduce) on = false;
      if (on === pulsing) return;
      pulsing = on;
      if (on) glow.play(); else { glow.pause(); gsap.to(dot, { '--gr': '6px', duration: 0.3, overwrite: 'auto' }); }
    },
    /** the hover state: pill + chip */
    setAwake(on: boolean) {
      if (on === awakeNow) return;
      awakeNow = on;
      drive(dock, on, 1.8); drive(chip, on, 1.4);
    },
    /** the ring is open (awake, hovered, or the plan is nearly used up) */
    setRing(on: boolean) { if (on !== ringNow) { ringNow = on; drive(ring, on, 1.4); } },
    setBreathing(on: boolean) {
      if (reduce || popping) on = false;
      if (on === breathing) return;
      breathing = on;
      if (on) { breath.play(); } else { breath.pause(); settle(); }
    },
    pop() {
      if (reduce) return;
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
