# gruponar.com brand restyle — design

**Date:** 2026-07-31
**Status:** implemented — `marketing/website-restyle/`

## Goal

Apply the Grupo NAR Design System to the existing gruponar.com homepage. Keep the
same sections and keep the hero background video.

## Constraints discovered during the site audit

The live site is WordPress 7.0.2 + Elementor 4.2.1, but the **theme is Woodmart**
and nearly all content is Woodmart widgets (`wd_title`, `wd_infobox`,
`wd_text_block`, `wd_testimonials`, `wd_blog`, `wd_contact_form_7`,
`wd_social_buttons`), not native Elementor widgets. Homepage is page ID 21.

This matters because the `Elementor Migration Guide.html` bundled in the design
project prescribes a from-scratch rebuild on a new page using native Elementor
containers and widgets. That conflicts with "keep the same sections", and would
require rebuilding the testimonial carousel, the blog feed and eleven infoboxes as
different widgets, then re-attaching the video.

Other findings that shaped the design:

- The hero video is an Elementor **background** video on section `7d1671f8`
  (`.home-banner`) — trivially preserved by not touching that section's markup.
- The contact block is rendered from the **theme footer** (Elementor template
  post-135), not the homepage body, though it appears on the homepage.
- Sections `7e3f0095` (services) and `284de268` (team) are full-bleed
  **photographs**, not flat colour. A `background-color` override does nothing
  behind an image, and dark type on them is invisible.
- All eleven `.wd-info-box` cards carry a wine background set per-widget.
- The team section has **no portraits** — it is text only.
- Contact Form 7 is form ID 7; its `your-message` field is a `[text]`, not a
  `[textarea]`.
- The theme's viewport tag disables pinch-zoom.

## Approach

**CSS restyle in place**, delivered as one stylesheet pasted into
Appearance → Customize → Additional CSS. Chosen over the guide's rebuild because
it matches the stated requirement, preserves every integration, and is reversible
by deleting one text box.

Rejected: rebuilding on a new "Home 2026" page (days of work, re-creates solved
problems); setting Elementor Global Colors/Fonts as the primary mechanism
(Woodmart widgets largely ignore Elementor globals, so it would not move the
needle on its own).

## Structure

Fourteen numbered layers in `gruponar-brand.css`:

0. Fonts — Abhaya Libre + Raleway + Poppins from Google; commented `@font-face`
   block for licensed Codec Warm, which the font stack already prefers.
1. Tokens — the design system's palette, type scale and rhythm as custom
   properties. Single point of control.
2. Ground and global type — warm paper, warm ink, Abhaya Libre headings,
   Raleway numerals, near-zero radii, hairlines instead of shadows, clay focus ring.
3. Header and nav — warm espresso with blur (not transparent; see decision below).
4. Hero — video untouched, gains a scrim inside the video container plus a 22s
   ken-burns drift.
5. Section rhythm — 120/60px, 1320px cap, paper/bone alternation, and a separate
   photographic treatment (scrim + z-index) for the two photo sections.
6. Titles — split by role across the seventeen `wd_title` widgets, using element
   IDs for the five section headings.
7. Info boxes — white cards on light grounds, hairline-only cards on the photo.
8. Testimonials — wine ground, inverted type, `<footer>` attribution styled.
9. Team — inverted type over its photograph, hairline separators.
10. Blog — white sheets on bone, wine date chip, Abhaya Libre titles.
11. Contact — wine-deep ground, square fields, one wine button.
12. Footer.
13. Responsive.
14. Reduced motion.

## Decisions worth recording

**Cards go white.** The design system states a resting card is white with one
hairline and no shadow, and reserves wine grounds for one-off brand panels.
Eleven wine cards is not that. Wine is retained where it carries meaning. A
commented block (§7.2) restores wine cards with correctly inverted type.

**Header stays dark.** The system wants transparent-over-hero → warm glass. The
logo lockup is white; a light glass bar over the drone video's bright frames
would swallow it. Espresso at 92% with blur is the safe default; the transparent
variant is commented at §3.1.

**Element IDs are acceptable here.** Five section headings are structurally
indistinguishable from eleven other titles. IDs are stable in the DB; the mapping
is documented in the README so it can be repaired in seconds if a widget is
recreated.

## Out of scope

Copy changes (including the Spanish/English mixing), the CF7 textarea fix, the
viewport pinch-zoom fix, and buying the Codec Warm licence. All four are
documented as known issues in the README with the exact remedy.

## Verification

Performed against a local mirror of the live homepage with the real stylesheet
linked: selector coverage 82/83, custom-property audit clean (caught an undefined
`--nar-white` that was blanking card backgrounds), WCAG AA contrast on all 127
text nodes at 1440px and 375px, no horizontal overflow, no sub-44px tap targets,
and non-regression checks on the video element, CF7 form ID and fields, the six
anchors, and the blog feed.
