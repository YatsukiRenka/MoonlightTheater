// Pointer-driven stagecraft: a follow spot over the stage, a moon whose light leans toward it,
// and a cast button that leans toward the hand. Only with a fine pointer and motion allowed.
const motion = window.matchMedia('(prefers-reduced-motion: no-preference)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const stage = document.querySelector('.stage');
const dial = document.querySelector('.hero-dial');
const cast = document.getElementById('generate');

let frame = 0;
let pointer = null;

function update() {
  frame = 0;
  if (!pointer || !stage) return;
  const box = stage.getBoundingClientRect();
  stage.style.setProperty('--spot-x', `${pointer.x - box.left}px`);
  stage.style.setProperty('--spot-y', `${pointer.y - box.top}px`);
  if (dial) {
    const moon = dial.getBoundingClientRect();
    const dx = (pointer.x - (moon.left + moon.width / 2)) / innerWidth;
    const dy = (pointer.y - (moon.top + moon.height / 2)) / innerHeight;
    dial.style.setProperty('--lean-x', Math.max(-1, Math.min(1, dx * 2)).toFixed(3));
    dial.style.setProperty('--lean-y', Math.max(-1, Math.min(1, dy * 2)).toFixed(3));
  }
  if (cast) {
    const button = cast.getBoundingClientRect();
    const dx = pointer.x - (button.left + button.width / 2);
    const dy = pointer.y - (button.top + button.height / 2);
    const near = Math.hypot(dx, dy) < Math.max(button.width, 120);
    cast.style.setProperty('--pull-x', near ? `${(dx * 0.16).toFixed(1)}px` : '0px');
    cast.style.setProperty('--pull-y', near ? `${(dy * 0.22).toFixed(1)}px` : '0px');
    cast.classList.toggle('is-near', near);
  }
}

function onMove(event) {
  pointer = {x: event.clientX, y: event.clientY};
  stage?.classList.add('has-spot');
  frame ||= requestAnimationFrame(update);
}

function onLeave() {
  pointer = null;
  stage?.classList.remove('has-spot');
  cast?.style.setProperty('--pull-x', '0px');
  cast?.style.setProperty('--pull-y', '0px');
  cast?.classList.remove('is-near');
  dial?.style.setProperty('--lean-x', '0');
  dial?.style.setProperty('--lean-y', '0');
}

function sync() {
  const enabled = motion.matches && finePointer.matches;
  if (enabled) {
    addEventListener('pointermove', onMove, {passive: true});
    document.documentElement.addEventListener('pointerleave', onLeave);
  } else {
    removeEventListener('pointermove', onMove);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    onLeave();
  }
}

motion.addEventListener('change', sync);
finePointer.addEventListener('change', sync);
sync();
