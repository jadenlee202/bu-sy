// Small UI helpers shared by every screen.
import { icon, terrier } from "./icons.js";

export const LEVEL = { quiet: "Quiet", moderate: "Moderate", busy: "Busy", unknown: "No data", closed: "Closed" };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmtCount = (v) => (v == null ? "—" : v < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v).toLocaleString());

/** Busyness is never color alone: a 3-step meter plus a word. */
export const level = (l, text = LEVEL[l]) =>
  `<span class="level" data-level="${l}"><span class="meter" aria-hidden="true"><i></i><i></i><i></i></span>${esc(text)}</span>`;

export function loading(text = "Fetching the latest…") {
  return `<div class="state is-loading" role="status">${terrier({ size: 44 })}<p>${esc(text)}</p></div>`;
}

export function failure(err, retry = "location.reload()") {
  return `<div class="state">${terrier({ size: 44, sleepy: true })}<p>${esc(err.message || "Something went wrong.")}</p>
    <button class="btn" onclick="${retry}">Try again</button></div>`;
}

// ---------- information icon ----------
// A small ⓘ button that reveals a longer note: on hover with a mouse, and on click, tap, Enter or
// Space (which keeps it open until you click outside, press Escape or activate it again). The note
// stays next to its button in the page; while open it's positioned (fixed) inside the viewport.
let tipCount = 0;

/** `label` names the button for screen readers ("About availability assumptions"); `html` is the note. */
export function infoTip(label, html) {
  const id = `info-${++tipCount}`;
  return `<span class="info"><button type="button" class="info-btn" aria-label="${esc(label)}" aria-expanded="false" aria-controls="${id}">${icon("info", 16)}</button><span class="info-panel" id="${id}" role="note" hidden>${html}</span></span>`;
}

/** Wires every infoTip on the page (call once). */
export function initInfoTips() {
  let current = null;   // { wrap, btn, panel, pinned }
  let hideTimer = 0;
  const MARGIN = 12;
  const place = () => {
    if (!current) return;
    if (!current.btn.isConnected) { current = null; return; }   // its screen re-rendered
    const { btn, panel } = current;
    const r = btn.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 2 * MARGIN);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(Math.max(r.left + r.width / 2 - width / 2, MARGIN), innerWidth - width - MARGIN)}px`;
    const height = panel.offsetHeight;
    const below = r.bottom + 6;
    // Below the icon unless that runs off the bottom and there's room above.
    panel.style.top = `${below + height > innerHeight - MARGIN && r.top - 6 - height > MARGIN ? r.top - 6 - height : below}px`;
  };
  const hide = () => {
    clearTimeout(hideTimer);
    if (!current) return;
    current.panel.hidden = true;
    current.btn.setAttribute("aria-expanded", "false");
    current.wrap.classList.remove("is-open");
    current = null;
  };
  const show = (btn, pinned) => {
    clearTimeout(hideTimer);
    if (current && current.btn !== btn) hide();
    const wrap = btn.closest(".info");
    current = { wrap, btn, panel: wrap.querySelector(".info-panel"), pinned: pinned || (current?.pinned ?? false) };
    current.panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    wrap.classList.add("is-open");
    place();
  };
  document.addEventListener("click", (event) => {
    const btn = event.target.closest(".info-btn");
    if (btn) {
      if (current?.btn === btn && current.pinned) hide(); else show(btn, true);
    } else if (current && !event.target.closest(".info-panel")) {
      hide();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !current) return;
    const btn = current.btn;
    hide();
    btn.focus();
  });
  document.addEventListener("pointerover", (event) => {
    if (event.pointerType !== "mouse") return;
    const wrap = event.target.closest(".info");
    if (wrap) show(wrap.querySelector(".info-btn"), false);
  });
  document.addEventListener("pointerout", (event) => {
    if (event.pointerType !== "mouse" || !current || current.pinned) return;
    if (current.wrap.contains(event.relatedTarget)) return;
    hideTimer = setTimeout(() => { if (current && !current.pinned) hide(); }, 200);   // time to move onto the note
  });
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  addEventListener("hashchange", hide);
}

