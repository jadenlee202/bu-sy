# Campus photos

Drop campus location photos here and declare them in
`web/data/campus-images.json` (keyed by location id). The app only uses files
listed in that manifest; it never fetches remote images.

Guidelines:
- Only add a photo you have the right to publish. Record its credit and license
  in the manifest.
- Match the photo to the correct location. Do not use a generic photo for a
  named BU place.
- Prefer a landscape image around 1200px wide, optimized (JPEG/WebP). The app
  lazy-loads and crops to a fixed ratio, so exact dimensions are flexible.
- A location with no file here simply shows the built-in illustration — never a
  broken image.

Expected filenames (match the manifest):
- `fitrec.jpg`   — FitRec (owner-provided; see manifest). Add this file to show it.
- `mugar.jpg`, `warren.jpg`, `marciano.jpg`, `west.jpg`, `fenway.jpg` — optional.
