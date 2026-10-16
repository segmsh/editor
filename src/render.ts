import type { Segment } from "@segmsh/core";
import { MarkerToken, VOID_TAGS, tokenize } from "./markers.js";

// Never rendered: active content and things that would leak into the host page
const DROPPED_TAGS: string[] = [
  "script", "style", "template", "noscript", "iframe", "frame", "frameset",
  "object", "embed", "applet", "base", "link", "meta", "portal",
];

// Rendered under another name, so they display but don't act or vanish
const REPLACED_TAGS: Record<string, string> = {
  html: "div",
  head: "div",
  body: "div",
  title: "div",
  form: "div",
  dialog: "div",
  button: "span",
  input: "span",
  select: "span",
  option: "span",
  textarea: "span",
};

// Node types that carry no visible content (md raw html, link definitions, …)
const HIDDEN_TYPES: string[] = ["comment", "doctype", "raw", "html!", "definition"];

const URL_ATTRIBUTES: string[] = [
  "href", "src", "action", "formaction", "poster", "background", "cite",
  "xlink:href", "data",
];

const UNSAFE_URL: RegExp = /^\s*(javascript|vbscript|data:(?!image\/))/i;

export const SEGMENT_CLASS = "sm-segment";

export interface TreeNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  value?: string;
  id?: string;
}

// hast property names to HTML attribute names (className → class, dataFoo → data-foo)
const toAttributeName = (key: string): string => {
  if (key === "className") return "class";
  if (key === "htmlFor") return "for";
  if (key === "httpEquiv") return "http-equiv";
  if (/^(data|aria)[A-Z]/.test(key)) {
    return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
  }
  return key.toLowerCase();
};

const toAttributeValue = (value: unknown): string | null => {
  if (value === null || value === undefined || value === false) return null;
  if (value === true) return "";
  if (Array.isArray(value)) return value.join(" ");
  if (typeof value === "object") return null;
  return String(value);
};

const setAttribute = (element: Element, name: string, value: string) => {
  // Host page ids and classes would collide with the document's, keep them as data
  if (name === "id" || name === "class") name = `data-${name}`;
  if (name.startsWith("on") || name === "srcdoc") return;
  if (URL_ATTRIBUTES.includes(name) && UNSAFE_URL.test(value)) return;

  try {
    element.setAttribute(name, value);
  } catch {
    // Invalid attribute name from the source document
  }
};

export const createElement = (
  doc: globalThis.Document,
  tagName: string,
  attributes: Record<string, unknown> = {},
  isAttributeMap = false,
): HTMLElement | null => {
  const name = tagName.toLowerCase();
  if (DROPPED_TAGS.includes(name)) return null;

  let element: HTMLElement;

  try {
    element = doc.createElement(REPLACED_TAGS[name] ?? tagName);
  } catch {
    element = doc.createElement("span");
  }

  element.dataset.tag = name;

  for (const [key, raw] of Object.entries(attributes)) {
    const value = toAttributeValue(raw);
    if (value === null) continue;
    setAttribute(element, isAttributeMap ? key : toAttributeName(key), value);
  }

  return element;
};

// Renders segment text as the inline markup its markers stand for
export const renderSegment = (
  doc: globalThis.Document,
  segment: Segment,
): DocumentFragment => {
  const fragment = doc.createDocumentFragment();
  const tokens = tokenize(segment.text);
  const stack: { parent: Node; token?: MarkerToken }[] = [{ parent: fragment }];
  const top = () => stack[stack.length - 1].parent;

  tokens.forEach((token, index) => {
    if (token.type === "text") {
      top().appendChild(doc.createTextNode(token.value));
      return;
    }

    if (token.closing) {
      const openIndex = stack.findLastIndex((entry) => entry.token?.name === token.name);
      if (openIndex > 0) stack.length = openIndex;
      return;
    }

    const element =
      createElement(doc, token.tagName, segment.tags?.[token.name] ?? {}, true) ??
      doc.createElement("span");

    element.dataset.marker = token.name;
    top().appendChild(element);

    const closed = tokens.some(
      (other, otherIndex) =>
        otherIndex > index &&
        other.type === "marker" &&
        other.closing &&
        other.name === token.name,
    );

    if (closed && !VOID_TAGS.includes(token.tagName)) {
      stack.push({ parent: element, token });
    }
  });

  return fragment;
};

export interface RenderedSegment {
  id: string;
  element: HTMLElement;
  // Elements that show hover and highlight for the whole block (paragraph, cell, row cells)
  highlight: HTMLElement[];
}

export interface RenderedBlock {
  key: string;
  element: HTMLElement;
  segmentIds: string[];
}

export interface RenderResult {
  segments: RenderedSegment[];
  blocks: RenderedBlock[];
  // True when the tree is the source file itself (toml, php, …) rather than markup
  source: boolean;
}

const isSourceTree = (root: TreeNode): boolean =>
  (root.children ?? []).some(
    (child) => child.type === "text" && !!child.value?.trim(),
  );

export const renderTree = (
  doc: globalThis.Document,
  root: TreeNode,
  target: HTMLElement,
): RenderResult => {
  const segments: RenderedSegment[] = [];
  const blocks = new Map<HTMLElement, RenderedBlock>();
  const paths = new WeakMap<HTMLElement, string>();

  // The element two panes align on: the segment's container, or the whole row for table cells
  const addToBlock = (container: HTMLElement, id: string) => {
    let element = container;
    const tag = element.dataset.tag;

    if ((tag === "td" || tag === "th") && element.parentElement?.dataset.tag === "tr") {
      element = element.parentElement;
    }

    const block = blocks.get(element);

    if (block) {
      block.segmentIds.push(id);
    } else {
      blocks.set(element, { key: paths.get(element) ?? "", element, segmentIds: [id] });
    }
  };

  const walk = (node: TreeNode, parent: HTMLElement, path: string) => {
    (node.children ?? []).forEach((child, index) => {
      const childPath = path ? `${path}.${index}` : `${index}`;

      if (child.type === "text") {
        parent.appendChild(doc.createTextNode(child.value ?? ""));
        return;
      }

      if (child.type === "segment" && child.id) {
        const element = doc.createElement("span");
        element.className = SEGMENT_CLASS;
        element.dataset.segmentId = child.id;
        parent.appendChild(element);
        segments.push({ id: child.id, element, highlight: [] });
        if (parent !== target) addToBlock(parent, child.id);
        return;
      }

      if (HIDDEN_TYPES.includes(child.type) || !child.tagName) return;

      const element = createElement(doc, child.tagName, child.properties);
      if (!element) return;

      // md front matter is a table of type "yaml"
      if (child.type !== "element") element.dataset.type = child.type;

      paths.set(element, childPath);
      parent.appendChild(element);
      walk(child, element, childPath);
    });
  };

  walk(root, target, "");

  // Highlight the segment's container when it holds only this segment; a table row whose
  // only segment is in this cell (key / value) lights up as a whole, cell by cell
  const count = (element: Element) => element.querySelectorAll(`.${SEGMENT_CLASS}`).length;

  for (const segment of segments) {
    const container = segment.element.parentElement;
    if (!container || container === target || count(container) !== 1) continue;

    const row = container.parentElement;
    const isCell = container.dataset.tag === "td" || container.dataset.tag === "th";

    segment.highlight =
      isCell && row?.dataset.tag === "tr" && count(row) === 1
        ? ([...row.children] as HTMLElement[])
        : [container];
  }

  return { segments, blocks: [...blocks.values()], source: isSourceTree(root) };
};
