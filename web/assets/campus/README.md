# Campus photos

Drop campus location photos here and declare them in
`web/data/campus-images.json` (keyed by location id). The app only uses files
listed in that manifest; it never fetches remote images.

Guidelines:
- Only add a photo you hold the rights to, or one under a license that permits
  this use (e.g. Creative Commons with attribution). Do NOT add copyrighted
  images — including official Boston University photography — without
  permission. Record credit, license, and source in the manifest.
- Match the photo to the correct location. Do not use a generic photo for a
  named BU place.
- Prefer a landscape image around 1200px wide, optimized (JPEG/WebP). The app
  lazy-loads and crops to a fixed ratio, so exact dimensions are flexible.
- A location with no file here simply shows the built-in illustration — never a
  broken image. No photos are bundled today; every location uses the
  illustration until a properly licensed file is added.

Expected filenames (match the manifest): `fitrec.jpg`, `mugar.jpg`,
`warren.jpg`, `marciano.jpg`, `west.jpg`, `fenway.jpg` — all optional.
