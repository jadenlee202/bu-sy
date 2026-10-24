// Small UI helpers shared by every screen.
import { terrier } from "./icons.js";

export const LEVEL = { quiet: "Quiet", moderate: "Moderate", busy: "Busy", unknown: "No data" };

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmtCount = (v) => (v == null ? "—" : v < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v).toLocaleString());

/** Busyness is never color alone: a 3-step meter plus a word. */
export const level = (l, text = LEVEL[l]) =>
  `<span class="level" data-level="${l}"><span class="meter" aria-hidden="true"><i></i><i></i><i></i></span>${esc(text)}</span>`;

export function loading(text = "Fetching the latest…") {
  return `<div class="state">${terrier({ size: 44 })}<p>${esc(text)}</p></div>`;
}

export function failure(err, retry = "location.reload()") {
  return `<div class="state">${terrier({ size: 44, sleepy: true })}<p>${esc(err.message || "Something went wrong.")}</p>
    <button class="btn" onclick="${retry}">Try again</button></div>`;
}
