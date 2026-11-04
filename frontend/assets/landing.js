import { $, $$, reveal, clock } from './util.js';
import { auth } from './auth.js';

// Nav turns solid once you scroll
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
onScroll();
window.addEventListener('scroll', onScroll, { passive: true });

reveal();

// Signed-in visitors get a shortcut to their dashboard
auth.isSignedIn().then((yes) => {
  if (yes) $('#nav-cta').innerHTML = '<a class="btn btn-dark" href="/app">Open dashboard</a>';
});

// Live countdowns in the preview, the floating chip and the ring
const start = Date.now();
const heroEnd = start + (5 * 3600 + 59 * 60 + 12) * 1000;
const ringTotal = 24 * 3600 * 1000;
const ringEnd = start + (17 * 3600 + 42 * 60 + 8) * 1000;
const ringVal = $('#ring .val');
const C = 2 * Math.PI * 52;
$$('[data-cd]').forEach((el) => { el.dataset.end = String(start + Number(el.dataset.cd) * 1000); });

function tick() {
  const now = Date.now();
  $('#hero-clock').textContent = clock(heroEnd - now);
  $('#ring-t').textContent = clock(ringEnd - now);
  if (ringVal) ringVal.style.strokeDashoffset = String(C * (1 - (ringEnd - now) / ringTotal));
  $$('[data-cd]').forEach((el) => {
    const s = Math.max(0, Math.floor((Number(el.dataset.end) - now) / 1000));
    el.textContent = `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
  });
}
tick();
setInterval(tick, 1000);
