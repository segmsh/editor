# @segmsh/editor

A framework-free editor for [segm.sh](https://segm.sh) documents. You load a parsed `Document` (from any segmsh processor), the editor shows it as a rendered page, and each segment can be edited in place. You get the document back with the edits, and events tell you what happens along the way.

- No runtime dependencies, about 17 KB minified. Use it from React, Vue, Svelte, a plain `<script>` tag, or as a `<segmsh-editor>` custom element.
- Inline markers (`{b0}…{/b0}`, `{img1}`) are edited as locked chips that can't be broken by typing. A commit is refused while markers are invalid.
- Works with every processor's output: markup (html, md), key/value tables (json, yaml) and source files (toml, php, properties, android-xml).

## Installation

```bash
npm install @segmsh/editor @segmsh/core
```

## Usage

```typescript
import { createEditor } from "@segmsh/editor";
import "@segmsh/editor/editor.css";
import MdProcessor from "@segmsh/md";

const processor = new MdProcessor();
const editor = createEditor(document.getElementById("editor")!, {
  document: processor.parse(source),
});

editor.on("change", ({ id, text, previous }) => save(id, text));

// later
const markdown = processor.stringify(editor.getDocument());
```

Without a bundler:

```html
<link rel="stylesheet" href="https://unpkg.com/@segmsh/editor/dist/editor.css">
<script src="https://unpkg.com/@segmsh/editor/dist/segmsh-editor.min.js"></script>
<script>
  const editor = SegmshEditor.createEditor(element, { document });
</script>
```

As a custom element:

```js
SegmshEditor.defineElement(); // registers <segmsh-editor>

const element = document.querySelector("segmsh-editor"); // <segmsh-editor readonly> for read-only
element.value = document;
element.addEventListener("segment-change", (event) => console.log(event.detail));
const edited = element.value;
```

## Editing

| Action | Keys |
| ------ | ---- |
| Open a segment | Click, or Enter / F2 on a focused segment |
| Save | The Save button, or click outside the field |
| Save and open the next one | Ctrl/⌘ + Enter |
| Save and move to next / previous | Tab / Shift + Tab |
| Cancel | Esc |
| New line | Enter |

Leaving the field saves it. If the markers are broken (unknown, duplicated, unclosed or misnested), the segment stays open with an error and an `invalid` event is emitted. Markers that were deleted are offered in the toolbar to put back: a pair wraps the selected text. Copy and paste keep markers as `{b0}` text.

## API

### `createEditor(container, options?)`

| Option | Description |
| ------ | ----------- |
| `document` | The `Document` to show. |
| `readOnly` | Show the document without editing; focus and hover events still fire. |
| `actions` | Toolbar buttons for the open segment: `{ label, title?, run({ segment, text, setText }) }`, e.g. machine translation. |
| `toolbar` | `false` hides the toolbar (keyboard only). |
| `segmentClass` | `(segment) => string \| string[]`: extra classes for a segment, e.g. a translation status. Re-applied by `refresh()`. |

### Methods

| Method | Description |
| ------ | ----------- |
| `setDocument(document)` | Loads a document. The editor works on a copy. |
| `getDocument()` | The document with committed edits. Tree, metadata and tags are kept. |
| `getSegment(id)` / `setSegment(id, text)` | Read or replace one segment. `setSegment` does not emit `change`. |
| `focusSegment(id)` | Scrolls to a segment and opens it. |
| `commit()` / `cancel()` | Saves or discards the open segment. `commit()` returns `false` if the markers are invalid. |
| `setReadOnly(readOnly)` | Switches modes. |
| `highlight(id, className?)` | Marks every occurrence of a segment. Each class name is its own highlight. The class goes on the segment and on its block: the containing element, or every cell of a table row whose only segment it is. |
| `refresh(id?)` | Re-applies `segmentClass`. |
| `getBlocks()` | Elements that contain segments, keyed by tree path (see below). |
| `getSegmentElements(id)` | The rendered elements of a segment. |
| `on(event, listener)` / `off(event, listener)` | Subscribe. `on` returns an unsubscribe function. |
| `destroy()` | Removes the editor. |

### Events

| Event | Payload | When |
| ----- | ------- | ---- |
| `focus` | `{ id, segment }` | A segment opens for editing (or is focused in read-only mode). |
| `blur` | `{ id, segment }` | It closes, after saving or cancelling. |
| `input` | `{ id, text }` | The open field changes. |
| `change` | `{ id, text, previous, segment }` | An edit is committed. |
| `invalid` | `{ id, text, errors }` | A commit is refused because of broken markers. |
| `hover` | `{ id }` | The pointer moves to another segment (`null` when it leaves). |

A segment id can appear more than once in the tree (identical texts get the same id). All occurrences share the text and update together.

## Side-by-side editors

A translation and its source share the same tree, so two editors can be paired. `getBlocks()` returns `{ key, element, segmentIds }` for every element holding a segment, with `key` being its tree path; table cells resolve to their row. Equalizing the heights of blocks with the same key keeps the panes aligned. Re-align on content changes too (a `MutationObserver` on `editor.element`), not only on resize: once a block has the pair's `min-height`, a `ResizeObserver` can't see it shrink when a segment closes. Then `highlight()` with the `hover` and `focus` events mirrors the active segment. See [examples/two-pane.html](examples/two-pane.html) for a complete host built on the public API.

## Styling

All classes are prefixed with `sm-`. The theme is a set of CSS variables on `.sm-editor` (`--sm-accent`, `--sm-font`, `--sm-chip`, …), see [src/editor.css](src/editor.css). Ids and classes from the document are kept as `data-id` and `data-class` so they don't clash with the host page. Scripts, styles, frames, event handlers and `javascript:` URLs are not rendered.

## Development

```bash
npm install
npm run build
npm test
npm run examples   # builds, regenerates examples/documents.js and copies the bundle; then open examples/index.html
```

## License

[Apache-2.0](LICENSE)
