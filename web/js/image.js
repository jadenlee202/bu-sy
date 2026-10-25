// Campus imagery, loaded safely.
//
// Photos live in web/data/campus-images.json, keyed by campus location id. A
// location with no usable photo shows a built-in SVG illustration instead of a
// broken image or a misleading stock photo. If a declared photo fails to load
// at runtime (missing file, bad path), the same illustration takes its place.
//
// Rules honoured here:
//   - Never invent image URLs; only the owner-provided manifest is used.
//   - Never fetch remote images; all sources are same-origin files.
//   - Always provide meaningful alt text and a graceful fallback.
//   - Lazy-load and size images so they don't slow the page.
import { esc } from "./ui.js";

let manifestPromise;

/** Load the image manifest once. Missing/broken manifest => no photos (all fallbacks). */
export function getImages() {
  manifestPromise ??= fetch("data/campus-images.json")
    .then((r) => (r.ok ? r.json() : { images: {} }))
    .catch(() => ({ images: {} }));
  return manifestPromise;
}

/** A BU-red campus-silhouette illustration, used whenever no photo is available. */
function fallbackSvg(label) {
  const title = esc(label || "Boston University campus");
  return `<svg class="campus-fallback" viewBox="0 0 400 240" role="img" aria-label="${title}" preserveAspectRatio="xMidYMid slice">
    <rect width="400" height="240" fill="var(--subtle)"/>
    <g fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linejoin="round" opacity="0.9">
      <path d="M40 180h120v-70l-60-34-60 34z"/>
      <path d="M100 76V58M94 58h12"/>
      <rect x="64" y="128" width="20" height="24"/><rect x="116" y="128" width="20" height="24"/>
      <rect x="170" y="96" width="90" height="84"/>
      <path d="M170 96l45-22 45 22"/>
      <path d="M186 118h14v18h-14zM220 118h14v18h-14zM186 150h14v18h-14zM220 150h14v18h-14z"/>
      <rect x="272" y="120" width="88" height="60" rx="30"/>
      <path d="M272 150h88M288 120v60M312 120v60M336 120v60"/>
    </g>
    <path d="M0 180h400" stroke="var(--line-strong)" stroke-width="2"/>
    <g fill="var(--red)" opacity="0.55"><circle cx="60" cy="196" r="4"/><circle cx="80" cy="200" r="4"/><circle cx="100" cy="196" r="4"/><circle cx="300" cy="198" r="4"/><circle cx="320" cy="194" r="4"/></g>
  </svg>`;
}

/**
 * Markup for one campus image slot.
 *   entry: the manifest record for a location, or null/undefined for none.
 *   label: human location name, used in alt/fallback text.
 *   ratio: CSS aspect-ratio string (default "16 / 9").
 * When a photo exists, it lazy-loads and, on error, swaps itself for the
 * illustration via a tiny inline handler (no remote calls, no broken icon).
 */
export function campusImage(entry, label, ratio = "16 / 9") {
  const fb = fallbackSvg(label);
  if (!entry || !entry.src) {
    return `<figure class="campus-photo" style="--ratio:${ratio}">${fb}</figure>`;
  }
  const alt = esc(entry.alt || label || "Boston University campus");
  const credit = entry.credit
    ? `<figcaption class="campus-credit">${esc(entry.credit)}${entry.license ? ` · ${esc(entry.license)}` : ""}</figcaption>`
    : "";
  // On load error, replace the <img> with the fallback illustration in place, and drop the
  // photo's credit line: it would otherwise credit a photo that isn't shown.
  const onerr = "this.closest('figure').querySelector('.campus-credit')?.remove();"
    + "this.replaceWith(this.nextElementSibling.content.cloneNode(true))";
  return `<figure class="campus-photo" style="--ratio:${ratio}">
    <img src="${esc(entry.src)}" alt="${alt}" loading="lazy" decoding="async" onerror="${onerr}">
    <template>${fb}</template>
    ${credit}
  </figure>`;
}
