# Social sharing image

The homepage, documentation, and guides use `public/social/cap-table-og-v1.jpg` at the absolute URL `https://captable.puter.com/social/cap-table-og-v1.jpg`.

- Export: 1200 × 630 pixels, opaque JPEG, quality 88, approximately 1.91:1.
- Design: existing teal app branding, large headline from the landing page, generous margins, and an abstract ownership pie chart. The illustration contains no customer data or financial metrics.
- Metadata: image URL, MIME type, intrinsic dimensions, descriptive alt text, and `summary_large_image` for X. Tags are in static HTML so crawlers do not need JavaScript.
- Use a new versioned filename for future artwork and update both `index.html` and `site/render.js` to avoid reusing a cached image URL.
- Deploy the full `dist/` directory. Existing social previews may need their page cache refreshed after deployment.

The metadata follows the [Open Graph structured image properties](https://ogp.me/#structured). The existing application icons remain available for favicons, installation, and structured-data logos.

## Generation

Created with the built-in imagegen tool using `public/icon-512.png` as the reference image. The generated master was exported to the final size and JPEG format with macOS `sips`:

```sh
sips -s format jpeg -s formatOptions 88 -z 630 1200 generated-card.png --out public/social/cap-table-og-v1.jpg
```

## Final prompt

```text
Use case: ads-marketing.
Asset type: production Open Graph social sharing card for the existing web app Cap Table by Puter. Create a finished landscape image exactly 1200 x 630 pixels (1.90476:1).
Input image 1: existing app icon; use this exact teal rounded-square ivory pie-chart mark in the brand lockup, preserving its identity. Do not make a new logo.
Primary request: a professional, modern, beautifully art-directed social card for free cap table software, consistent with the app's refined teal and white design. The card must be immediately readable as a small link preview.
Scene/backdrop: near-white #fdfdfd canvas, extremely subtle cool mint atmosphere behind the right illustration, generous negative space. No outer border or rounded canvas corners.
Composition: balanced editorial layout. Left copy area occupies approximately x=68 to 650; right sculptural ownership illustration occupies approximately x=740 to 1130, y=185 to 470. Keep all text and meaningful elements at least 64px inside the edges. Upper-left brand lockup: referenced app icon at about 52px square, then “Cap Table” in dark near-black medium-bold sans serif at about 30px, with “by Puter” in small restrained dark gray. Main headline below, at x=68 around y=218, in beautifully kerned large 66px bold Swiss-style sans serif, two lines exactly: “Every share” then “accounted for.” First line near-black #101113, second line deep teal #0c706c. Supporting line underneath at about y=401, 27px dark gray: “Free cap table software.” Bottom-left around y=539: “cap-table.io” in 22px medium weight dark teal.
Subject: right-side striking sculptural 3D pie chart, a single thick solid circular disk divided into three distinct precision-cut ownership wedges, with one small wedge subtly separated outward. It is NOT a donut: solid center, three clean wedges together form a complete pie. Large wedge in deep teal #0c706c, medium wedge in brand turquoise #17a39e, smaller wedge in pale mint. Satin ceramic surfaces, tasteful isometric perspective, refined soft studio shadows, crisp edges. Grounded on the clean white background. This is an abstract ownership illustration, not a screenshot. No numeric labels.
Style/medium: premium fintech editorial design with immaculate flat typography and one restrained 3D hero object; elegant and calm, strong visual hierarchy, substantial whitespace.
Text (verbatim and only these words): “Cap Table”, “by Puter”, “Every share”, “accounted for.”, “Free cap table software.”, “cap-table.io”.
Constraints: exact spelling, headline readable at thumbnail size, keep text separate from art, preserve existing icon, opaque image.
Avoid: extra copy, fake UI, invented metrics, tiny chart labels, buttons, badges, people, stock photography, dollar signs, coins, decorative clutter, grids, neon glows, purple, watermark.
```
