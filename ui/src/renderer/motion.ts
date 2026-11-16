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
  gsap.set(label, { opacity: 0.72 });
  gsap.set(detail, { maxWidth: 0, marginLeft: -8, autoAlpha: 0 });
  const chip = gsap.timeline({ paused: true, defaults: { ease: EASE } })
    .to(p.chip, { y: 0, '--bgo': 1, duration: 0.42 }, 0)
    .to(label, { opacity: 1, duration: 0.3 }, 0)
    .to(detail, { maxWidth: 260, marginLeft: 0, duration: 0.42 }, 0.04)
    .to(detail, { autoAlpha: 1, duration: 0.3 }, 0.12);
  chip.timeScale(speed).progress(0);

  // ---- the usage ring: a small quiet arc by the pet; it grows and shows its number when awake ----
  gsap.set(p.ring, { scale: 0.62, opacity: 0.6, transformOrigin: '50% 50%' });
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
  const breath = gsap.to(p.sprite, { y: -1.5, scaleX: 1.012, scaleY: 1.02, duration: 1.8, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true });
  let breathing = false;
  const settle = () => { gsap.to(p.sprite, { y: 0, scaleX: 1, scaleY: 1, duration: 0.35, ease: 'power2.out', overwrite: 'auto' }); };

  return {
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
