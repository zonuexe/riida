# riida DESIGN.md

This file documents the current visual design system and UI language for `riida`.

It is intentionally design-facing, not architecture-facing. The previous repository document named `DESIGN.md` now lives at [docs/design-doc.md](docs/design-doc.md).

## Overview

`riida` is a desktop reading and library-management app with a warm, editorial visual language. The default appearance should feel closer to a paper-and-wood reading room than to a generic productivity dashboard.

The UI is built around:

- a two-pane shell with a persistent sidebar and a document-focused main stage
- translucent panels layered over a themed atmospheric background
- soft serif typography for the app chrome
- rounded controls with gentle blur and shadow
- subdued, tactile interaction states instead of loud high-contrast marketing styling

When generating new screens or extending the interface, preserve the sense that the app is for reading first and administration second.

Important context:

- Parts of the current visual language originated from early AI-assisted implementation rather than from a formally designed system.
- Some choices that now feel characteristic were originally accidental or emergent.
- This file should therefore distinguish between:
  - traits worth preserving because they work well in practice
  - traits that happen to exist today but are open to refinement

## Design Principles

### 1. Reading-first calm

Even utility screens should support a contemplative reading mood. Prefer restrained motion, soft surfaces, and generous padding over dense dashboard layouts.

### 2. Editorial, not corporate

The app shell uses serif typography and warm materials. Avoid generic SaaS visual language, harsh grids, or overly technical-looking chrome.

### 3. Floating glass over material background

Most surfaces are translucent or semi-translucent panels on top of a rich background gradient. New primary containers should usually feel like frosted cards, pills, or sheets rather than flat rectangles.

### 4. Rounded, touch-friendly geometry

Controls are highly rounded. Circular and pill-shaped actions are preferred for overlays and navigation. Large panels use softer radii with subtle depth.

### 5. Theme-driven consistency

The same component rules apply across all themes. Themes should change mood and material, not layout logic or hierarchy.

### 6. Desktop-first, not browser-first

When there is a choice between web-app conventions and native desktop-app conventions, prefer the desktop side. The UI should feel closer to a native reading tool than to a responsive SaaS dashboard in a browser tab.

## Theme System

The app currently supports four themes. New UI should consume semantic theme roles, not hard-code colors.

### Theme names and symbols

- `default`
- `snow-white`
- `night-city`
- `navy-blue`

### Theme application rules

- Persist the selected theme in config and mirror it to `localStorage` under `riida.appTheme`.
- Apply the cached theme before the main stylesheet-driven UI becomes visible.
- Use `color-scheme: light` for `default` and `snow-white`.
- Use `color-scheme: dark` for `night-city` and `navy-blue`.
- Treat all four themes as peer options. `default` is not the canonical design source for the others; it is simply the theme selected by default on install.

### Viewer background naming

App-wide themes and document-viewer background styles should be treated as separate concepts.

- App-wide themes define the chrome, panels, sidebar, overlays, and overall atmosphere.
- Viewer background styles define the reading surface behind PDF or EPUB content.
- Viewer background selection currently reuses the four app theme names rather than introducing a separate paper-material naming system.

Current viewer background options:

- `Default`
- `Snow White`
- `Night City`
- `Navy Blue`
- `Inherit app setting`

Intent:

- Reusing theme names keeps the option set understandable and compact.
- `Inherit app setting` is the default and should behave as a standard checkbox rather than as a fifth swatch.
- Color selection swatches should be unlabeled circular chips, visually similar to Kindle's page-color chooser, with the explanatory text reserved for the inheritance checkbox.

### Default theme

Creative direction: warm library, parchment, sepia, late-afternoon sunlight.

Historical note:

- This theme originated from the initial AI-assisted implementation, not from a deliberate human-designed brand system.
- It is still worth preserving because the warm palette works well and is liked in practice.
- Do not treat it as the root theme that all others must derive from.

Core colors:

- Background start: `#f5ecd7`
- Background mid: `#efe2c4`
- Background end: `#e3d0aa`
- Background glow: `rgb(255 244 214)`
- Primary ink: `rgb(31 27 22)`
- Accent: `rgb(125 78 33)`
- Accent soft: `rgb(183 121 61)`
- Border: `rgb(96 70 33)`
- Panel: `rgb(255 250 240)`
- Surface: `rgb(255 255 255)`
- Sidebar material: `rgb(246 233 203)`
- Shadow: `rgb(74 44 18)`
- Danger: `rgb(161 62 43)`
- Success: `rgb(46 107 66)`
- Focus selection: `rgb(0 90 255)`

### Snow White theme

Creative direction: paper white, soft silver, quiet blue emphasis.

Core colors:

- Background start: `#f5f5f7`
- Background mid: `#ececf1`
- Background end: `#e1e3ea`
- Primary ink: `rgb(34 34 38)`
- Accent: `rgb(0 122 255)`
- Accent soft: `rgb(87 168 255)`
- Border: `rgb(60 60 67)`
- Panel and surface: `rgb(255 255 255)`
- Sidebar material: `rgb(245 245 247)`
- Shadow: `rgb(24 24 28)`

### Night City theme

Creative direction: graphite glass dark mode, electric blue highlights.

Core colors:

- Background start: `#1c1c1e`
- Background mid: `#151618`
- Background end: `#101114`
- Background glow: `rgb(53 84 140)`
- Primary ink: `rgb(242 242 247)`
- Accent: `rgb(10 132 255)`
- Accent soft: `rgb(94 178 255)`
- Border: `rgb(99 99 102)`
- Panel: `rgb(44 44 46)`
- Surface: `rgb(58 58 60)`
- Sidebar material: `rgb(32 32 34)`
- Shadow/backdrop: near-black

### Navy Blue theme

Creative direction: deep blue study, maritime night, luminous blue accents.

Core colors:

- Background start: `#0d1b2a`
- Background mid: `#10233a`
- Background end: `#18314f`
- Background glow: `rgb(57 89 135)`
- Primary ink: `rgb(229 237 247)`
- Accent: `rgb(118 171 255)`
- Accent soft: `rgb(164 200 255)`
- Border: `rgb(77 107 145)`
- Panel: `rgb(18 31 49)`
- Surface: `rgb(28 43 63)`
- Sidebar material: `rgb(16 29 46)`
- Shadow/backdrop: `rgb(4 10 20)` and `rgb(3 8 18)`

## Semantic Color Roles

Use these roles when describing or implementing new UI:

- `ink`: primary text and icon color
- `accent`: primary interactive emphasis, selected actions, links, large stats
- `accent-soft`: softer brand highlight when a lighter accent is needed
- `border`: outlines, separators, control strokes
- `panel`: frosted cards, sheets, pills, overlay containers
- `surface`: denser input and content surfaces inside panels
- `sidebar`: the left navigation material
- `backdrop`: modal scrim and heavy shadow color
- `danger`: destructive actions and validation errors
- `success`: success messages
- `focus`: selection and text selection highlight

## Typography

### Primary family

Use:

- `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif`

This is the default shell typeface and should remain the primary voice for headings, navigation, labels, and interface copy unless a very strong reason exists to do otherwise.

Important caveat:

- This serif-heavy direction also originated partly from AI inference around the reading context, not from a strongly intentional typographic system.
- It is acceptable, and often desirable, to replace some UI controls with more readable OS-style UI fonts where clarity matters more than atmosphere.
- Search inputs, utility fields, dense controls, and other highly interactive widgets are especially good candidates for a more neutral system UI font treatment in future refinements.

### Monospace family

Use:

- `"SF Mono", "Menlo", "Monaco", monospace`

Apply to code snippets, path displays, raw license text, and machine-like content.

### Type scale

Current recurring sizes:

- App brand / hero title: `clamp(2rem, 4vw, 3.2rem)`, tight line height, negative letter spacing
- Major modal title: `1.8rem`
- Large stat number: `clamp(2.5rem, 6vw, 4rem)`, bold
- Section titles: around `1.1rem`
- Default body: browser base `16px`
- Small utility copy: `0.88rem` to `0.95rem`
- Kicker / eyebrow labels: `0.78rem` to `0.82rem`, uppercase, wide tracking
- Tiny metadata / tags / overlays: `0.72rem` to `0.84rem`

### Typography rules

- Prefer weight and spacing changes over multiple font families.
- Use uppercase tracked labels sparingly for chrome, not for long-form content.
- Avoid condensed all-caps headings for the main reading experience.
- Preserve generous line-height for prose-like or explanatory UI copy.
- Prefer readability over atmosphere for high-frequency interactive controls.
- It is acceptable for form controls and search-heavy widgets to diverge from the serif shell voice when that improves legibility.

## Layout and Spacing

### App shell

- Two-column layout
- Sidebar width: `280px`
- Main pane padding: `20px 28px 32px`
- Sidebar padding: `32px 20px 24px`

### Grid and spacing rhythm

Frequent spacing values:

- `4px`, `6px`, `8px`, `10px`, `12px`, `14px`, `16px`, `18px`, `20px`, `24px`, `28px`, `32px`

Use these as the core spacing scale. New custom gaps should be rare.

### Responsive behavior

- At narrower widths, the two-pane layout collapses to a single column.
- Metadata editor grids collapse from two columns to one.
- Tag editor add rows collapse vertically on small screens.

## Radius, Blur, and Depth

### Radius system

- Tiny controls: `4px` to `8px`
- Inputs and small chips: `12px` to `14px`
- Cards and rows: `16px` to `24px`
- Pills and floating action controls: `999px`
- Modals: `26px`

### Blur

Blur is part of the design language.

- Primary panels: around `blur(10px)`
- Modals: around `blur(6px)` scrim plus translucent dialog background
- Floating note panel: heavier blur around `18px`

### Shadows

Shadows should feel soft and material, not harsh or high-contrast.

Common levels:

- Small floating controls: `0 8px 18px`
- Primary panels: `0 20px 40px`
- Floating note sheet: `0 24px 56px`
- Modal dialog: `0 28px 80px`

## Core Components

### Sidebar

Pattern:

- Semi-translucent material panel
- Vertical stack of brand, actions, search, and tree navigation
- Rounded utility buttons
- Nested directory or section rows with subtle indentation

Behavior:

- Collapses by sliding away rather than hard disappearing
- Active rows use a translucent accent fill
- Search is pill-shaped and embedded in the sidebar tool stack

Sidebar collapse toggle:

- Pill-shaped tab button anchored to the main-pane's left edge
- Always renders as if half-embedded in a vertical edge: half of the button is hidden, half is visible and clickable
- When the sidebar is open, it straddles the sidebar/main-pane boundary so the visible half reads as a tab attached to the sidebar's right edge
- When the sidebar is collapsed, the same button sits half-buried in the screen's left edge so it remains discoverable without floating freely in the reading stage
- The half-buried geometry doubles as the left-alignment baseline for other left-edge overlay chrome

### Panels

Pattern:

- Frosted card with `24px` radius
- Semi-transparent panel background
- 1px soft border
- Medium atmospheric shadow

Use for:

- Home stats
- Main library container
- Any new summary or settings-like content block

### Buttons

Primary button:

- Pill shape
- Strong accent fill
- Light text
- Used for confirm / save / done actions

Secondary button:

- Pill shape
- Bordered translucent panel fill
- Neutral or ink-colored text
- Used for cancel, add, alternate actions

Danger button:

- Pill shape
- Light danger tint with danger text and border
- Use only for destructive actions

Icon buttons:

- Circular or capsule floating chrome
- Semi-translucent panel fill
- Used for viewer overlay actions, nav arrows, sidebar collapse

### Inputs

Pattern:

- Rounded `12px` to `14px`
- 1px border
- Surface fill
- Typography inherits from the app shell

Search fields:

- Usually pill-shaped for global or library search
- Compact rectangular capsule for PDF in-document search

### Modal dialogs

Pattern:

- Centered frosted sheet with heavy radius
- Backdrop blur + dim scrim
- Clear header / scrollable body / footer action bar

Voice:

- Feels like a desktop sheet, not a web marketing modal

### Viewer overlay controls

Pattern:

- Float above the reading stage
- Keep compact and unobtrusive
- Use pills for labeled actions, circles for utility toggles

Left-edge alignment:

- Left-aligned overlay chrome (history navigation, EPUB TOC toggle, EPUB TOC panel) shares a single left baseline that clears the half-buried sidebar collapse toggle by a small gap
- Do not place left-aligned overlay buttons closer to the edge than this baseline; doing so would re-create the original overlap with the collapse toggle

### Viewer settings panel

Pattern:

- Small floating settings sheet on the reading stage
- Grid layout
- Two tabs for global vs file scope
- File scope uses a stronger tinted background

### Library rows

Pattern:

- Book thumbnail on the left, metadata stack on the right
- Rounded row hit target
- Bottom divider between rows
- Title shifts to accent on hover/focus
- Selected row uses a subtle accent wash

Metadata stack hierarchy (top to bottom):

- Title — primary serif weight; the only line that takes accent on hover/focus
- Author byline — one step below the title in weight and ink opacity, acting like a book's printed byline; authors past the third collapse into a `他N名` suffix, and the line is omitted entirely when no authors are known
- Muted metadata strip — a single small low-opacity line joining publisher, publication year, file location, and file size with middot (`·`) separators; missing fields drop out so separators never dangle
- Tag row — user-applied chips plus the row's edit actions

The strip deliberately demotes the file location and size (technical detail) to the same muted line as the bibliographic publisher/year so the title and author byline carry the visual weight. The grid hover popup uses the same byline-then-strip treatment (omitting the location); the compact grid caption stays title-only.

Thumbnail rules:

- `72 × 102`
- `4px` radius
- Paper-like gradient if no real cover is visible

### Tags and chips

Pattern:

- Small rounded capsules
- Accent-tinted fill
- Ink-colored text
- Low visual weight compared with primary actions

### Floating notes

Pattern:

- Draggable, resizable, translucent floating sheet
- Low-opacity resting state, high-opacity on hover/focus
- Feels like a lightweight desktop note window rather than a rigid side panel

### Reading stage

Pattern:

- Large soft container with muted tinted background
- Main content centered and elevated
- PDF pages and search UI should sit inside this frame without breaking its calm visual hierarchy

Viewer background guidance:

- Independent viewer background choice should remain visually subordinate to the app-wide theme.
- For PDF, the effective implementation applies the selected background color to `section.main-pane`; this is the intended reading-surface target for empty viewer space.
- For EPUB, the selected viewer color preset should apply both background color and a matching body text color inside the reader document.
- `default` and `snow-white` should use dark reading text; `night-city` and `navy-blue` should use light reading text.
- EPUB should expose the same viewer-settings controls as PDF, even if some of those controls currently have a stronger effect in PDF.js than in epub.js.
- The background-color controls should be visually separated from layout and cover settings by a clearer divider or section boundary.

## Motion and Interaction

- Use short, quiet transitions, typically around `120ms` to `180ms`
- Favor opacity, transform, background-color, border-color, and shadow changes
- Avoid springy or decorative motion
- Motion should help the UI feel alive but never distract from reading

Practical note:

- `riida` is not expected to generate heavy volumes of notifications or constantly changing attention-grabbing UI while reading.
- "Reading-first" should therefore be interpreted mostly as avoiding noisy chrome, excessive overlays, and visual interruption, rather than as a detailed notification policy.

## States

### Hover

- Usually lighten panel opacity or increase accent emphasis
- Keep hover subtle

### Active / selected

- Use soft accent tints instead of solid fills where possible
- Selected items should feel highlighted, not button-pressed

### Disabled

- Lower opacity rather than inventing a new palette

### Error / success

- Use semantic colors directly
- Keep status messages understated and inline when possible

## Accessibility

Follow broadly accepted desktop and web accessibility practices, even when the visual language is soft or atmospheric.

### Accessibility rules

- Maintain clear contrast between text and its background in every supported theme.
- Ensure interactive controls remain identifiable even when panels are translucent.
- Keep keyboard focus visibly distinct; do not rely on hover alone.
- Preserve readable sizing for utility text and never shrink important interaction text below practical readability.
- Avoid conveying meaning by color alone; destructive, success, selected, and disabled states should also be distinguishable through placement, labeling, border treatment, or opacity.
- Motion should remain subtle and non-essential. If a behavior can work without animation, prefer that approach.
- Reader overlays and floating controls should remain discoverable and usable with keyboard navigation.

### Accessibility intent

- The app may have a crafted, atmospheric appearance, but readability and operability take precedence over decorative purity.
- When a stylistic choice conflicts with clarity, clarity wins.

## Do

- Describe styles with both mood and exact values
- Reuse the semantic color roles above
- Keep panels translucent and rounded
- Preserve serif-driven editorial tone in the app shell
- Keep reader overlays compact and respectful of content
- Use pills, circles, and soft rectangles instead of sharp boxes
- Design new features so they feel like part of a desktop reading tool, not a generic admin app

## Don’t

- Don’t introduce default system sans-serif as the main shell voice
- Don’t flatten the app into plain white rectangles
- Don’t use overly saturated destructive reds or neon accents
- Don’t replace blur-and-material layering with hard opaque slabs unless the component truly needs it
- Don’t make primary actions square-cornered
- Don’t crowd the reading stage with persistent heavy chrome
- Don’t create a new visual language per theme; themes should stay structurally identical
- Don’t make the app feel like a browser-based analytics dashboard.
- Don’t force serif styling into compact, search-heavy, or utility-first controls when readability suffers.
- Don’t depend on low-contrast elegance if it makes text, focus, or action hierarchy hard to perceive.
- Don’t introduce large banners, toast storms, or other attention-seeking UI patterns into the reading flow unless the feature absolutely requires them.

## Implementation Notes

- The current source of truth for visual tokens is [src/styles.css](/Users/megurine/repo/rust/riida/src/styles.css).
- The shell structure and major component regions live in [index.html](/Users/megurine/repo/rust/riida/index.html).
- Theme persistence and early application behavior live in [src/main.ts](/Users/megurine/repo/rust/riida/src/main.ts).
- When updating the visual language, update this file alongside token or component changes so AI and humans stay aligned.
