// An original, hand-drawn Boston skyline — pure SVG, no photograph, no
// copyrighted asset. Recognisable silhouette shapes (Prudential Tower, 200
// Clarendon / "the Hancock", the Custom House clock tower, a Zakim-style
// cable-stayed bridge) over the Charles River with a couple of sailboats.
// Drawn with currentColor + theme tokens so it fits light and dark themes.
//
// viewBox is 1200x400; it scales to any hero size via preserveAspectRatio.

export function bostonSkyline() {
  return `<svg class="skyline" viewBox="0 0 1200 400" preserveAspectRatio="xMidYMax slice"
      role="img" aria-label="Illustration of the Boston skyline across the Charles River" focusable="false">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--sky-top)"/>
        <stop offset="1" stop-color="var(--sky-bottom)"/>
      </linearGradient>
      <linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--river-top)"/>
        <stop offset="1" stop-color="var(--river-bottom)"/>
      </linearGradient>
    </defs>

    <!-- sky + sun glow -->
    <rect width="1200" height="400" fill="url(#sky)"/>
    <circle cx="930" cy="150" r="190" fill="var(--sun)" opacity="0.5"/>
    <circle cx="930" cy="150" r="54" fill="var(--sun)" opacity="0.85"/>

    <!-- far buildings (lighter, behind) -->
    <g fill="var(--city-far)">
      <rect x="40" y="210" width="46" height="100"/>
      <rect x="96" y="232" width="34" height="78"/>
      <rect x="150" y="196" width="40" height="114"/>
      <rect x="430" y="214" width="38" height="96"/>
      <rect x="478" y="188" width="46" height="122"/>
      <rect x="1030" y="206" width="44" height="104"/>
      <rect x="1086" y="228" width="40" height="82"/>
    </g>

    <!-- main skyline (foreground silhouette) -->
    <g fill="var(--city-near)">
      <!-- low blocks left -->
      <rect x="60" y="250" width="70" height="60"/>
      <rect x="138" y="236" width="52" height="74"/>
      <rect x="196" y="258" width="44" height="52"/>

      <!-- Custom House clock tower -->
      <rect x="250" y="150" width="46" height="160"/>
      <rect x="258" y="130" width="30" height="24"/>
      <rect x="268" y="150" width="10" height="10" fill="var(--sky-bottom)"/>
      <polygon points="258,130 273,108 288,130"/>

      <!-- mid blocks -->
      <rect x="312" y="224" width="58" height="86"/>
      <rect x="378" y="246" width="40" height="64"/>

      <!-- 200 Clarendon ("the Hancock"): tall slim glass tower -->
      <rect x="540" y="96" width="60" height="214"/>
      <rect x="548" y="96" width="8" height="214" fill="var(--city-glass)" opacity="0.5"/>

      <!-- Prudential Tower: broad with a stepped crown -->
      <rect x="628" y="120" width="92" height="190"/>
      <rect x="652" y="104" width="44" height="18"/>
      <rect x="668" y="86" width="12" height="20"/>

      <!-- stepped cluster -->
      <rect x="738" y="196" width="50" height="114"/>
      <rect x="792" y="168" width="44" height="142"/>
      <rect x="840" y="214" width="40" height="96"/>

      <!-- right-side blocks -->
      <rect x="900" y="236" width="56" height="74"/>
      <rect x="962" y="214" width="46" height="96"/>
    </g>

    <!-- simple lit-window texture on two signature towers -->
    <g fill="var(--window)" opacity="0.65">
      ${windows(540, 96, 60, 214, 4, 14)}
      ${windows(628, 120, 92, 190, 6, 12)}
    </g>

    <!-- Zakim-style cable-stayed bridge on the right -->
    <g stroke="var(--city-near)" stroke-width="4" fill="none">
      <path d="M1096 310 V150"/>
      <path d="M1088 168 l-52 142 M1088 196 l-40 114 M1088 224 l-28 86"/>
      <path d="M1104 168 l40 142 M1104 196 l30 114"/>
    </g>
    <rect x="1020" y="306" width="180" height="8" fill="var(--city-near)"/>

    <!-- Charles River -->
    <rect y="310" width="1200" height="90" fill="url(#water)"/>
    <g stroke="var(--river-line)" stroke-width="2" opacity="0.5">
      <path d="M80 338 h200 M360 338 h260 M700 338 h180 M920 338 h200"/>
      <path d="M140 362 h300 M520 362 h240 M820 362 h260"/>
    </g>

    <!-- two little sailboats -->
    <g fill="var(--sail)">
      <polygon points="360,318 360,296 384,318"/>
      <polygon points="388,318 388,302 404,318"/>
      <rect x="356" y="318" width="52" height="5" rx="2"/>
    </g>
    <g fill="var(--sail)" opacity="0.8">
      <polygon points="700,322 700,304 720,322"/>
      <rect x="696" y="322" width="30" height="4" rx="2"/>
    </g>
  </svg>`;
}

/** A sparse grid of window dots across a building face. */
function windows(x, y, w, h, cols, rows) {
  const padX = 10, padY = 14, size = 3;
  const gx = (w - padX * 2) / Math.max(1, cols - 1);
  const gy = (h - padY * 2) / Math.max(1, rows - 1);
  let out = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2 === 0) continue; // scatter, not every cell
      const cx = x + padX + c * gx;
      const cy = y + padY + r * gy;
      out += `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${size}" height="${size}"/>`;
    }
  }
  return out;
}
