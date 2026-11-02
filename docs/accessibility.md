# Accessibility

OpenPortrait aims to meet WCAG 2.2 AA in the studio app and the pages clients see.

## What is in place

- Every page has one `main` landmark and a skip link that appears when you tab into the page.
- Text and controls meet AA contrast in the light and dark themes (4.5:1 for text, 3:1 for large text and borders).
- Controls can be used by keyboard alone, with a visible focus ring.
- Choice groups use real radio inputs or buttons with `aria-pressed`, never a label standing in for a radio.
- Layouts reflow down to a 390 px wide phone with no sideways scrolling.
- Animations and transitions switch off when the visitor asks for reduced motion.

## Checking a change

Run the app with a throwaway studio (never a real one), then scan the routes you touched with [axe-core](https://github.com/dequelabs/axe-core) in a browser at three settings: a 1280 px light window, a 390 px light window, and a 1280 px window with dark colours. A change should add no serious or critical findings. Also check:

1. Tab through the page. Focus should be visible and move in reading order.
2. Zoom to 200 %. Nothing should be cut off.
3. Look for a sideways scrollbar at phone width.

## Reporting a problem

Open an issue describing the page, what you used (screen reader, keyboard, zoom), and what happened.
