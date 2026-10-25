// Boston terrier mark + a few line icons, as SVG strings.
// The terrier's white blaze, muzzle and eyes are cut out with a mask, so the
// page background shows through in both light and dark mode.

let uid = 0;

export function terrier({ size = 28, sleepy = false, label = "" } = {}) {
  const id = `terrier-mask-${++uid}`;
  const eyes = sleepy
    ? `<path d="M19.6 32.4q2.9 2.8 5.8 0M38.6 32.4q2.9 2.8 5.8 0" stroke="#000" stroke-width="2" fill="none" stroke-linecap="round"/>`
    : `<circle cx="22.5" cy="32" r="3.2" fill="#000"/><circle cx="41.5" cy="32" r="3.2" fill="#000"/>`;
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  return `<svg class="terrier" width="${size}" height="${size}" viewBox="0 0 64 64" ${a11y}>
    <defs><mask id="${id}">
      <rect width="64" height="64" fill="#fff"/>
      <path d="M30 15.5h4l2.6 23h-9.2z" fill="#000"/>
      <ellipse cx="32" cy="45" rx="11.5" ry="7" fill="#000"/>
      ${eyes}
    </mask></defs>
    <g fill="currentColor">
      <g mask="url(#${id})">
        <path d="M12.5 30C9.5 20 8.5 10.5 10.5 4.5c.7-2.2 3.1-2.6 4.7-1L28.5 17z"/>
        <path d="M51.5 30c3-10 4-19.5 2-25.5-.7-2.2-3.1-2.6-4.7-1L35.5 17z"/>
        <ellipse cx="32" cy="35.5" rx="21" ry="18.5"/>
      </g>
      <ellipse cx="32" cy="41.6" rx="4.6" ry="3.1"/>
      <path d="M32 44.5v2M28.8 47.2q3.2 2 6.4 0" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    </g>
  </svg>`;
}

export const paw = (size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <ellipse cx="12" cy="16.2" rx="5" ry="4.2"/><ellipse cx="5.4" cy="10.6" rx="2.1" ry="2.7"/>
    <ellipse cx="9.4" cy="6.4" rx="2.1" ry="2.8"/><ellipse cx="14.6" cy="6.4" rx="2.1" ry="2.8"/>
    <ellipse cx="18.6" cy="10.6" rx="2.1" ry="2.7"/></svg>`;

const PATHS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.3-4.3"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  study: '<path d="M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2zM22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z"/>',
  eat: '<path d="M4 2v7a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V2M7.5 2v20M20 15V2a5 5 0 0 0-4 5v6a2 2 0 0 0 2 2h2zm0 0v7"/>',
  workout: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m9 21 3-6.5 3 2.5v4M6.5 12l3-4 4 1 2.5 3h3"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};

export const icon = (name, size = 18) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
