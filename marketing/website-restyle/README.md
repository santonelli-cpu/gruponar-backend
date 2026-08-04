# gruponar.com — brand restyle

Applies the [Grupo NAR Design System](https://claude.ai/design/p/ad53f653-8a14-431f-8199-73aca3546bbf)
to the existing homepage as a stylesheet. **Nothing is rebuilt in Elementor.**
Same sections, same widgets, same hero video, same contact form, same blog feed.

The whole change is one file: [`gruponar-brand.css`](gruponar-brand.css).

---

## Apply it

1. WordPress admin → **Appearance → Customize → Additional CSS**
2. Paste the entire contents of `gruponar-brand.css`
3. Press **Publish**
4. Clear your caching plugin, then **Elementor → Tools → Regenerate CSS & Data**
5. Look at the site in a private window, on desktop and phone

**Take a backup first.** UpdraftPlus → Backup Now → tick everything. It costs five
minutes and it is the difference between a bad afternoon and a bad month.

## Undo it

Delete it from the same Additional CSS box and press Publish. That is the entire
rollback — there is no migration, no new page, no changed setting to put back.

---

## What changed

| | Before | After |
|---|---|---|
| Page ground | pure white `#FFFFFF` | warm paper `#FAF8F5` |
| Body type | Raleway 14px `#656565` | Codec Warm 17px `#3A322C`, line-height 1.62 |
| Headings | Raleway 600 | Abhaya Libre 600, espresso `#22130B` |
| Numerals | Raleway (everywhere) | Raleway (numerals only, as the manual specifies) |
| Labels & buttons | untracked | uppercase at `.28em` / `.14em` — the brand's signature |
| Cards | wine bars, all eleven | white on paper with 1px hairlines |
| Services & Team | photo, unprotected type | photo + scrim, inverted type |
| Testimonials | flat wine | wine ground, hairline frames, tracked attribution |
| Contact & footer | wine | wine-deep `#2C0906` |
| Section rhythm | inconsistent | 120px desktop / 60px mobile, 1320px max |
| Radii & shadows | rounded, soft shadows | 0–2px, hairlines instead of shadows |

### Deliberately left alone

The hero video (source, autoplay, loop, mobile playback), Contact Form 7 markup
and email routing, the Woodmart blog widget, all six anchors and the Client Portal
link, Meta Pixel, Google Site Kit, and every word of copy.

---

## Two decisions you may want to revisit

**The cards are now white.** All eleven info boxes carried a wine background set
per-widget in Elementor. The design system says a resting card is white with one
hairline and no shadow, and reserves wine grounds for one-off brand panels —
eleven wine cards is not that. So wine now lives where it carries meaning: the
testimonial band, the contact ground, the buttons, the 01/02/03 counters, the
section rules. **To keep the wine cards instead**, see §7.2 of the stylesheet;
it is a commented block plus removing one `!important`.

**The header stayed dark.** The design system wants a header that is transparent
over the hero and warm glass once scrolled. Your logo lockup is white, and over
the brightest frames of the drone video a light glass bar would swallow it. So
the header is warm espresso at 92% with a blur rather than pure black. §3.1 has
the transparent version commented out if you want to try it — test it against the
video before keeping it.

---

## Known issues this stylesheet does *not* fix

These need more than CSS. Listed in the order I would deal with them.

1. **Pinch-zoom is disabled.** The Woodmart theme ships
   `maximum-scale=1.0, user-scalable=no` in its viewport tag. This is an
   accessibility failure and it frustrates exactly the demographic buying
   property abroad. Fix in a child theme's `functions.php`:

   ```php
   add_action( 'wp_head', function () {
       echo '<meta name="viewport" content="width=device-width, initial-scale=1">';
   }, 1 );
   ```

   Then remove the theme's own tag, or ensure yours wins.

2. **The contact form's message field is a single-line text input.** In Contact
   Form 7 (form ID 7) `your-message` is a `[text]` tag, not `[textarea]`. People
   writing a real enquiry get one cramped line. Change it to
   `[textarea your-message]` in the CF7 editor — the stylesheet already has the
   textarea rule waiting.

3. **The page mixes languages.** "NUESTRO EQUIPO" sits above English body copy.
   Your clients are foreign investors; the design system's own guidance is never
   to mix languages inside one composition. This is a copy decision, not a style
   one — a restyle cannot fix it and I have not touched any wording.

4. **Codec Warm is not licensed yet.** The stylesheet asks for `"Codec Warm"`
   first and falls back to Poppins, so the site looks right today. When you buy
   the Zetafonts webfont licence: upload the `.woff2` files to Media, then
   uncomment the `@font-face` block at §0.1 and paste the four URLs in. The
   switch happens on save; no other edit is needed.

---

## A note on the Elementor element IDs

Five rules target Elementor element IDs, because the five section headings are
otherwise indistinguishable from the eleven other titles on the page:

| ID | Heading |
|---|---|
| `96936df` | ABOUT / Gruponar Legal Consultants |
| `3ed7620f` | HOW WE CAN HELP YOU? |
| `6daf8e6` | TESTIMONIALS |
| `7df228d1` | nuestro equipo |
| `1c97ee1` | BLOG |

Plus `8af574c` (the "we are a lawfirm" sub-head) and `5007d25c` / `76b8d09` /
`5cd55d8` (the three lawyer names).

These IDs are stable in the database. Editing a heading's *text* is fine. If you
ever **delete and re-add** one of those widgets, Elementor mints a new ID and
that one rule stops applying — find the new ID in the Elementor panel
(Advanced → the `data-id` in the DOM) and swap it in §6.

---

## How this was verified

Against a local mirror of the live homepage with the real stylesheet linked:

- **Selector coverage** — 82 of 83 site-specific selectors match live elements.
  The one miss is `.cus-footer .elementor-icon-list-icon svg`, an intentional
  companion to the `<i>` rule since Elementor renders either depending on
  icon settings.
- **Token audit** — every `var(--…)` referenced is defined. (This caught a real
  bug: `--nar-white` was used but undefined, which silently blanked every card
  background instead of making it white.)
- **Contrast** — all 127 text nodes on the page pass WCAG AA against their
  effective background, at 1440px and at 375px.
- **Mobile** — no horizontal overflow, no tap target under 44px, section padding
  and type scale step down correctly.
- **Non-regression** — video element intact (`homevideo.mp4`, autoplay/loop/
  muted/playsinline), CF7 form ID 7 with all four field names intact, all six
  anchors present, five blog posts still rendering, no console errors.
