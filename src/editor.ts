import type { Document, Segment } from "@segmsh/core";
import {
  MarkerError,
  MarkerKind,
  markerKinds,
  missingMarkers,
  tokenize,
  validate,
} from "./markers.js";
import { RenderedSegment, SEGMENT_CLASS, TreeNode, renderSegment, renderTree } from "./render.js";
import type {
  ActionContext,
  Block,
  EditorEventName,
  EditorEvents,
  EditorOptions,
} from "./types.js";

type AllowedMarkers = Map<string, { kind: MarkerKind; tagName: string }>;

interface Session {
  id: string;
  element: HTMLElement;
  previous: string;
  allowed: AllowedMarkers;
}

type Listener<K extends EditorEventName> = (event: EditorEvents[K]) => void;

const CHIP_CLASS = "sm-chip";

const clone = <T>(value: T): T => structuredClone(value);

const emptyDocument = (): Document => ({ tree: { type: "root", children: [] }, segments: [] });

// Field DOM (text, marker chips, line breaks) back to segment text
const readField = (field: Node): string => {
  let text = "";

  const walk = (parent: Node) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue ?? "";
      } else if (node instanceof HTMLElement) {
        if (node.dataset.marker) {
          text += `{${node.dataset.marker}}`;
        } else if (node.tagName === "BR") {
          // A trailing <br> only makes the last empty line visible
          if (node !== parent.lastChild || parent !== field) text += "\n";
        } else {
          if (node.tagName === "DIV" && text && !text.endsWith("\n")) text += "\n";
          walk(node);
        }
      }
    });
  };

  walk(field);

  return text;
};

export class Editor {
  readonly element: HTMLElement;

  private readonly view: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly options: EditorOptions;
  private readOnly: boolean;
  private doc: Document = emptyDocument();
  private segments = new Map<string, Segment>();
  private initialText = new Map<string, string>();
  private rendered: RenderedSegment[] = [];
  private blocks: Block[] = [];
  private session: Session | null = null;
  private closing = false;
  private hoverId: string | null = null;
  private highlights = new Map<string, string | null>();
  private listeners = new Map<EditorEventName, Set<Listener<any>>>();
  private customClasses = new WeakMap<HTMLElement, string[]>();
  // Block elements (see RenderedSegment.highlight) to the segment they belong to
  private blockOwners = new WeakMap<HTMLElement, HTMLElement>();

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    this.options = options;
    this.readOnly = !!options.readOnly;

    const doc = container.ownerDocument;
    this.element = doc.createElement("div");
    this.element.className = "sm-editor";
    this.view = doc.createElement("div");
    this.view.className = "sm-doc";
    this.toolbar = doc.createElement("div");
    this.toolbar.className = "sm-toolbar";
    this.element.appendChild(this.view);
    this.element.classList.toggle("sm-readonly", this.readOnly);
    container.replaceChildren(this.element);

    this.listen();
    this.setDocument(options.document ?? emptyDocument());
  }

  // ---- Public API ----

  setDocument(document: Document): void {
    this.cancel();

    this.doc = clone(document);
    this.segments = new Map(this.doc.segments.map((segment) => [segment.id, segment]));
    this.initialText = new Map(this.doc.segments.map((segment) => [segment.id, segment.text]));
    this.hoverId = null;
    this.highlights.clear();
    this.view.replaceChildren();

    const result = renderTree(
      this.view.ownerDocument,
      this.doc.tree as unknown as TreeNode,
      this.view,
    );

    this.rendered = result.segments;
    this.blockOwners = new WeakMap();

    for (const entry of this.rendered) {
      entry.highlight.forEach((block) => this.blockOwners.set(block, entry.element));
    }
    this.blocks = result.blocks;
    this.view.classList.toggle("sm-source", result.source);

    for (const { id, element } of this.rendered) {
      element.tabIndex = 0;
      this.renderContent(id, element);
    }
  }

  // The loaded document with committed edits; an open edit is not included until commit()
  getDocument(): Document {
    return clone({
      ...this.doc,
      segments: this.doc.segments.map((segment) => ({
        ...segment,
        text: this.segments.get(segment.id)?.text ?? segment.text,
      })),
    });
  }

  getSegment(id: string): Segment | undefined {
    const segment = this.segments.get(id);
    return segment && clone(segment);
  }

  // Programmatic update; does not emit "change"
  setSegment(id: string, text: string): boolean {
    const segment = this.segments.get(id);
    if (!segment) return false;

    segment.text = text;

    if (this.session?.id === id) {
      this.mergeAllowed(this.session.allowed, text);
      this.fill(text);
    }

    this.renderSegment(id);

    return true;
  }

  focusSegment(id: string): boolean {
    const element = this.rendered.find((entry) => entry.id === id)?.element;
    if (!element) return false;

    element.scrollIntoView?.({ block: "nearest" });

    if (this.readOnly) {
      element.focus();
    } else {
      this.open(element);
    }

    return true;
  }

  // Commits the open edit; false when its markers are invalid and the edit stays open
  commit(): boolean {
    const session = this.session;
    if (!session) return true;

    const text = readField(session.element);
    const errors = validate(text, session.allowed);

    if (errors.length) {
      session.element.classList.add("sm-invalid");
      this.renderToolbar(errors);
      this.emit("invalid", { id: session.id, text, errors });
      return false;
    }

    const segment = this.segments.get(session.id)!;
    this.close();

    if (text !== session.previous) {
      segment.text = text;
      this.renderSegment(session.id);
      this.emit("change", {
        id: session.id,
        text,
        previous: session.previous,
        segment: clone(segment),
      });
    }

    this.emit("blur", { id: session.id, segment: clone(segment) });

    return true;
  }

  // Discards the open edit
  cancel(): void {
    const session = this.session;
    if (!session) return;

    this.close();
    this.emit("blur", { id: session.id, segment: clone(this.segments.get(session.id)!) });
  }

  setReadOnly(readOnly: boolean): void {
    if (readOnly && !this.commit()) this.cancel();
    this.readOnly = readOnly;
    this.element.classList.toggle("sm-readonly", readOnly);
  }

  // Marks all occurrences of a segment, e.g. to mirror hover or focus from another pane.
  // Each class name is its own highlight, so several can be shown at once.
  highlight(id: string | null, className: string = "sm-highlight"): void {
    this.toggleClass(this.highlights.get(className) ?? null, className, false);
    this.highlights.set(className, id);
    this.toggleClass(id, className, true);
  }

  // Re-applies segmentClass, for one segment or all
  refresh(id?: string): void {
    for (const entry of this.rendered) {
      if (id === undefined || entry.id === id) this.applyClasses(entry.id, entry.element);
    }
  }

  // Elements holding segments, keyed by tree path, for aligning two editors side by side
  getBlocks(): Block[] {
    return this.blocks.map((block) => ({ ...block, segmentIds: [...block.segmentIds] }));
  }

  getSegmentElements(id: string): HTMLElement[] {
    return this.rendered.filter((entry) => entry.id === id).map((entry) => entry.element);
  }

  get activeSegmentId(): string | null {
    return this.session?.id ?? null;
  }

  on<K extends EditorEventName>(name: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
    return () => this.off(name, listener);
  }

  off<K extends EditorEventName>(name: K, listener: Listener<K>): void {
    this.listeners.get(name)?.delete(listener);
  }

  destroy(): void {
    this.closing = true;
    this.session = null;
    this.listeners.clear();
    this.element.remove();
  }

  // ---- Rendering ----

  private emit<K extends EditorEventName>(name: K, event: EditorEvents[K]): void {
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }

  private renderSegment(id: string): void {
    for (const entry of this.rendered) {
      if (entry.id === id && entry.element !== this.session?.element) {
        this.renderContent(id, entry.element);
      }
    }
  }

  private renderContent(id: string, element: HTMLElement): void {
    const segment = this.segments.get(id);

    element.classList.toggle("sm-missing", !segment);
    element.replaceChildren(segment ? renderSegment(element.ownerDocument, segment) : "");
    this.applyClasses(id, element);
  }

  private applyClasses(id: string, element: HTMLElement): void {
    const segment = this.segments.get(id);
    const previous = this.customClasses.get(element) ?? [];
    const value = segment && this.options.segmentClass?.(clone(segment));
    const next = (Array.isArray(value) ? value : (value ?? "").split(/\s+/)).filter(Boolean);

    element.classList.remove(...previous);
    element.classList.add(...next);
    this.customClasses.set(element, next);
  }

  private blockOf(element: HTMLElement): HTMLElement[] {
    return this.rendered.find((entry) => entry.element === element)?.highlight ?? [];
  }

  private toggleClass(id: string | null, className: string, force: boolean): void {
    if (id === null) return;
    for (const entry of this.rendered) {
      if (entry.id !== id) continue;
      entry.element.classList.toggle(className, force);
      entry.highlight.forEach((element) => element.classList.toggle(className, force));
    }
  }

  // ---- Editing session ----

  private mergeAllowed(allowed: AllowedMarkers, text: string): void {
    markerKinds(text).forEach((value, key) => {
      if (!allowed.has(key)) allowed.set(key, value);
    });
  }

  private open(element: HTMLElement): void {
    const id = element.dataset.segmentId!;
    const segment = this.segments.get(id);
    if (!segment || this.readOnly) return;

    if (this.session) {
      if (this.session.element === element) return;

      if (!this.commit()) {
        this.session.element.focus();
        return;
      }
    }

    const allowed = markerKinds(this.initialText.get(id) ?? segment.text);
    this.mergeAllowed(allowed, segment.text);
    this.session = { id, element, previous: segment.text, allowed };

    element.classList.add("sm-editing");
    this.blockOf(element).forEach((block) => block.classList.add("sm-editing-block"));
    element.setAttribute("contenteditable", "true");
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-multiline", "true");
    this.fill(segment.text);

    if (this.options.toolbar !== false) {
      element.after(this.toolbar);
      this.renderToolbar();
    }

    element.focus();
    this.placeCaretAtEnd();
    this.emit("focus", { id, segment: clone(segment) });
  }

  private close(): void {
    const session = this.session;
    if (!session) return;

    this.closing = true;
    this.session = null;

    const { element } = session;
    element.classList.remove("sm-editing", "sm-invalid");
    this.blockOf(element).forEach((block) => block.classList.remove("sm-editing-block"));
    element.removeAttribute("contenteditable");
    element.removeAttribute("role");
    element.removeAttribute("aria-multiline");
    this.toolbar.remove();
    this.renderContent(session.id, element);

    // Leave no caret, focus ring or stale hover on the closed segment
    const doc = element.ownerDocument;
    const selection = doc.getSelection();
    if (selection?.anchorNode && element.contains(selection.anchorNode)) selection.removeAllRanges();
    if (doc.activeElement === element) element.blur();
    this.closing = false;

    if (this.hoverId === session.id) this.setHover(null);
  }

  private move(delta: number): void {
    const element = this.session?.element;
    if (!element || !this.commit()) return;

    const index = this.rendered.findIndex((entry) => entry.element === element);
    const next = this.rendered[index + delta];

    if (next) {
      next.element.scrollIntoView?.({ block: "nearest" });
      this.open(next.element);
    }
  }

  private createChip(name: string, closing: boolean): HTMLElement {
    const doc = this.view.ownerDocument;
    const kind = this.session?.allowed.get(name)?.kind;
    const chip = doc.createElement("span");
    const attributes = this.segments.get(this.session?.id ?? "")?.tags?.[name] ?? {};

    chip.className = `${CHIP_CLASS} ${CHIP_CLASS}-${kind === "pair" ? (closing ? "close" : "open") : "void"}`;
    chip.setAttribute("contenteditable", "false");
    chip.dataset.marker = (closing ? "/" : "") + name;
    // Drawn by CSS: real text would join the chip to the adjacent word on double-click
    chip.dataset.label = name;
    chip.title = [`{${chip.dataset.marker}}`]
      .concat(Object.entries(attributes).map(([key, value]) => `${key}="${value}"`))
      .join(" ");

    return chip;
  }

  // Text to field nodes: marker strings become chips
  private fieldNodes(text: string): Node[] {
    const doc = this.view.ownerDocument;

    return tokenize(text).map((token) =>
      token.type === "text"
        ? doc.createTextNode(token.value)
        : this.createChip(token.name, token.closing),
    );
  }

  private fill(text: string): void {
    const element = this.session?.element;
    if (!element) return;

    element.replaceChildren(...this.fieldNodes(text));
    this.fixTrailingBreak();
  }

  // A trailing newline needs a <br> after it to be visible and reachable
  private fixTrailingBreak(): void {
    const element = this.session?.element;
    if (!element) return;

    const last = element.lastChild;
    if (last instanceof HTMLElement && last.tagName === "BR") last.remove();

    if (readField(element).endsWith("\n")) {
      element.appendChild(element.ownerDocument.createElement("br"));
    }
  }

  private fieldRange(): Range | null {
    const element = this.session?.element;
    const selection = element?.ownerDocument.getSelection();
    if (!element || !selection?.rangeCount) return null;

    const range = selection.getRangeAt(0);
    return element.contains(range.commonAncestorContainer) ? range : null;
  }

  private setCaret(range: Range): void {
    const selection = this.view.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  private placeCaretAtEnd(): void {
    const element = this.session?.element;
    if (!element) return;

    const range = element.ownerDocument.createRange();
    const last = element.lastChild;

    if (last instanceof HTMLElement && last.tagName === "BR") {
      range.setStartBefore(last);
    } else {
      range.selectNodeContents(element);
      range.collapse(false);
    }

    this.setCaret(range);
  }

  private insertNodes(nodes: Node[], caretAfter?: Node): void {
    let range = this.fieldRange();

    if (!range) {
      this.placeCaretAtEnd();
      range = this.fieldRange();
      if (!range) return;
    }

    range.deleteContents();

    const fragment = this.view.ownerDocument.createDocumentFragment();
    nodes.forEach((node) => fragment.appendChild(node));
    const last = caretAfter ?? fragment.lastChild;

    range.insertNode(fragment);

    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      this.setCaret(range);
    }

    this.onFieldInput();
  }

  private insertMarker(name: string): void {
    const session = this.session;
    if (!session) return;

    const kind = session.allowed.get(name)?.kind;

    if (kind !== "pair") {
      this.insertNodes([this.createChip(name, false)]);
      return;
    }

    // Wrap the selection, or insert an empty pair with the caret inside
    const range = this.fieldRange();
    const content = range && !range.collapsed ? range.extractContents() : null;
    const open = this.createChip(name, false);
    const close = this.createChip(name, true);

    this.insertNodes(
      content ? [open, content, close] : [open, close],
      content ? close : open,
    );
  }

  private onFieldInput(): void {
    const session = this.session;
    if (!session) return;

    this.fixTrailingBreak();

    const text = readField(session.element);

    if (session.element.classList.contains("sm-invalid") && !validate(text, session.allowed).length) {
      session.element.classList.remove("sm-invalid");
    }

    this.renderToolbar();
    this.emit("input", { id: session.id, text });
  }

  private renderToolbar(errors: MarkerError[] = []): void {
    const session = this.session;
    if (!session || this.options.toolbar === false) return;

    const doc = this.view.ownerDocument;
    const text = readField(session.element);
    const button = (label: string, className: string, onClick: () => void, title?: string) => {
      const element = doc.createElement("button");
      element.type = "button";
      element.className = className;
      element.textContent = label;
      if (title) element.title = title;
      element.addEventListener("click", onClick);
      return element;
    };

    const markers = missingMarkers(text, session.allowed).map((name) =>
      button(
        name,
        `${CHIP_CLASS} ${CHIP_CLASS}-${session.allowed.get(name)?.kind === "pair" ? "pair" : "void"}`,
        () => this.insertMarker(name),
        `Insert {${name}}`,
      ),
    );

    const actions = (this.options.actions ?? []).map((action) =>
      button(action.label, "sm-button", () => action.run(this.actionContext()), action.title),
    );

    const row = doc.createElement("div");
    row.className = "sm-toolbar-row";
    row.append(...markers, ...actions);

    const spacer = doc.createElement("span");
    spacer.className = "sm-spacer";
    row.append(
      spacer,
      button("Cancel", "sm-button", () => this.cancel(), "Cancel (Esc)"),
      button("Save", "sm-button sm-button-primary", () => this.commit(), "Save (Ctrl+Enter saves and opens the next)"),
    );

    this.toolbar.replaceChildren(row);

    if (errors.length) {
      const message = doc.createElement("div");
      message.className = "sm-toolbar-error";
      message.setAttribute("role", "alert");
      message.textContent = errors.map((error) => error.message).join(" · ");
      this.toolbar.appendChild(message);
    }
  }

  private actionContext(): ActionContext {
    const session = this.session!;

    return {
      segment: clone(this.segments.get(session.id)!),
      text: readField(session.element),
      setText: (text: string) => {
        if (this.session !== session) return;
        this.mergeAllowed(session.allowed, text);
        this.fill(text);
        session.element.focus();
        this.placeCaretAtEnd();
        this.onFieldInput();
      },
    };
  }

  // ---- DOM events ----

  private listen(): void {
    const view = this.view;
    const inField = (event: Event) =>
      !!this.session && this.session.element.contains(event.target as Node);
    // The segment under the pointer: its text, or anywhere in its block, so the gaps
    // between lines and around the text count too
    const segmentOf = (event: Event): HTMLElement | null => {
      const target = event.target as Element | null;
      const segment = target?.closest?.(`.${SEGMENT_CLASS}`) as HTMLElement | null;
      if (segment) return segment;

      for (let element = target; element && element !== view; element = element.parentElement) {
        const owner = this.blockOwners.get(element as HTMLElement);
        if (owner) return owner;
      }

      return null;
    };

    // Open on mousedown: saving the open segment removes its toolbar and shifts the
    // layout, so by mouseup the pointer may be over something else and no click fires
    view.addEventListener("mousedown", (event) => {
      const segment = segmentOf(event);
      if (event.button !== 0 || this.readOnly || !segment || !view.contains(segment)) return;
      if (segment === this.session?.element) {
        // Empty space in the open segment's own block keeps the field focused
        if (!segment.contains(event.target as Node)) event.preventDefault();
        return;
      }

      event.preventDefault();
      this.open(segment);
    });

    // Links in the document never navigate away from the host app
    view.addEventListener("click", (event) => {
      if ((event.target as Element).closest?.("a")) event.preventDefault();
    });

    view.addEventListener("keydown", (event) => {
      if (!inField(event)) {
        const segment = segmentOf(event);
        if (segment && event.target === segment && (event.key === "Enter" || event.key === "F2")) {
          event.preventDefault();
          this.open(segment);
        }
        return;
      }

      if (event.isComposing) return;

      if (event.key === "Escape") {
        event.preventDefault();
        this.cancel();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.move(1);
      } else if (event.key === "Tab") {
        event.preventDefault();
        this.move(event.shiftKey ? -1 : 1);
      }
    });

    view.addEventListener("beforeinput", (event) => {
      if (!inField(event)) return;

      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        this.insertNodes([view.ownerDocument.createTextNode("\n")]);
      } else if (event.inputType.startsWith("format") || event.inputType === "insertFromDrop") {
        event.preventDefault();
      }
    });

    view.addEventListener("input", (event) => {
      if (inField(event)) this.onFieldInput();
    });

    view.addEventListener("paste", (event) => {
      if (!inField(event)) return;

      event.preventDefault();
      const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      this.insertNodes(this.fieldNodes(text));
    });

    const copy = (event: ClipboardEvent, cut: boolean) => {
      const range = this.fieldRange();
      if (!inField(event) || !range || range.collapsed) return;

      event.preventDefault();
      event.clipboardData?.setData("text/plain", readField(range.cloneContents()));

      if (cut) {
        range.deleteContents();
        this.onFieldInput();
      }
    };

    view.addEventListener("copy", (event) => copy(event, false));
    view.addEventListener("cut", (event) => copy(event, true));

    view.addEventListener("drop", (event) => {
      if (inField(event)) event.preventDefault();
    });

    view.addEventListener("focusin", (event) => {
      const segment = segmentOf(event);
      if (!this.readOnly || !segment || event.target !== segment) return;

      const id = segment.dataset.segmentId!;
      const data = this.segments.get(id);
      this.toggleClass(id, "sm-active", true);
      if (data) this.emit("focus", { id, segment: clone(data) });
    });

    view.addEventListener("focusout", (event) => {
      const segment = segmentOf(event);

      if (this.readOnly) {
        if (!segment || event.target !== segment) return;

        const id = segment.dataset.segmentId!;
        const data = this.segments.get(id);
        this.toggleClass(id, "sm-active", false);
        if (data) this.emit("blur", { id, segment: clone(data) });
        return;
      }

      const related = event.relatedTarget as Node | null;
      if (this.closing || !this.session || event.target !== this.session.element) return;
      if (related && (this.toolbar.contains(related) || this.session.element.contains(related))) return;

      // Leaving the field saves it; invalid markers keep it open
      this.commit();
    });

    // Keep focus and selection in the field while using the toolbar
    this.toolbar.addEventListener("mousedown", (event) => event.preventDefault());

    view.addEventListener("mouseover", (event) => {
      const segment = segmentOf(event);
      this.setHover(segment && view.contains(segment) ? segment.dataset.segmentId! : null);
    });

    view.addEventListener("mouseleave", () => this.setHover(null));
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;

    this.toggleClass(this.hoverId, "sm-hover", false);
    this.hoverId = id;
    this.toggleClass(id, "sm-hover", true);
    this.emit("hover", { id });
  }
}

export const createEditor = (container: HTMLElement, options?: EditorOptions): Editor =>
  new Editor(container, options);
