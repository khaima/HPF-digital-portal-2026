/* ============================================================
   Shared utilities: DOM helpers, storage, formatting, and the
   global count-up controller (re-animates all numbers every 5s
   while the tab is active).
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const read = (k, fb) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; }
};
export const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const initials = (name = "") =>
  name.trim().split(/\s+/).slice(0, 2).map((p) => p[0] || "").join("").toUpperCase() || "U";

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2));

export const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

/* ---------------------------------------------------------- toast */
export function toast(title, desc = "", type = "default") {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    document.body.appendChild(region);
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${
    desc ? `<div class="t-desc">${esc(desc)}</div>` : ""
  }`;
  region.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s ease, transform .3s ease";
    el.style.opacity = "0";
    el.style.transform = "translateX(20px)";
    setTimeout(() => el.remove(), 300);
  }, 3400);
}

/* ---------------------------------------------------------- number counters */
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function formatNum(value, el) {
  const target = +el.dataset.count;
  const v = Math.round(value);
  if (el.dataset.compact !== undefined) return compactFmt.format(v);
  if (target >= 1000) return v.toLocaleString();
  return String(v);
}

/* Animate a single .count element from 0 -> data-count (timer-driven so it
   works even where requestAnimationFrame is throttled). */
export function animateCount(el) {
  const target = +el.dataset.count;
  if (Number.isNaN(target)) return;
  const suffix = el.dataset.suffix || "";
  const dur = 1300;
  const start = Date.now();
  if (el._countTimer) clearInterval(el._countTimer);
  el.textContent = "0" + suffix;
  el._countTimer = setInterval(() => {
    const t = Math.min((Date.now() - start) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatNum(target * eased, el) + suffix;
    if (t >= 1) {
      clearInterval(el._countTimer);
      el._countTimer = null;
    }
  }, 16);
}

/* Animate every .count on the page, from zero. */
export function runCounters() {
  $$(".count").forEach((el) => animateCount(el));
}

let _tick = null;
const INTERVAL = 5000;

/* Start the global loop: every 5s (while the tab is active) all numbers
   restart their count-up from zero. Pauses while the tab is hidden and
   resumes (with an immediate run) when it becomes visible again. */
export function startGlobalCounters() {
  if (_tick) return;
  runCounters();
  _tick = setInterval(runCounters, INTERVAL);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runCounters();
  });
}
