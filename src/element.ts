import type { Document } from "@segmsh/core";
import { Editor } from "./editor.js";
import type { EditorEventName, EditorOptions } from "./types.js";

const EVENTS: EditorEventName[] = ["focus", "blur", "input", "change", "invalid", "hover"];

export interface SegmshEditorElement extends HTMLElement {
  readonly editor: Editor;
  // Set to load a document, read to get it with committed edits
  value: Document;
  options: Omit<EditorOptions, "document" | "readOnly">;
}

// Registers <segmsh-editor>. Editor events are re-dispatched as bubbling
// "segment-<name>" CustomEvents (segment-change, segment-focus, …) with the payload in detail.
export const defineElement = (name: string = "segmsh-editor"): void => {
  if (customElements.get(name)) return;

  class Element extends HTMLElement implements SegmshEditorElement {
    static observedAttributes = ["readonly"];

    private instance: Editor | null = null;
    private pending: Document | null = null;
    options: Omit<EditorOptions, "document" | "readOnly"> = {};

    get editor(): Editor {
      if (!this.instance) {
        this.instance = new Editor(this, {
          ...this.options,
          document: this.pending ?? undefined,
          readOnly: this.hasAttribute("readonly"),
        });
        this.pending = null;

        for (const event of EVENTS) {
          this.instance.on(event, (detail) =>
            this.dispatchEvent(new CustomEvent(`segment-${event}`, { detail, bubbles: true })),
          );
        }
      }

      return this.instance;
    }

    get value(): Document {
      return this.instance ? this.instance.getDocument() : structuredClone(this.pending!);
    }

    set value(document: Document) {
      if (this.instance) {
        this.instance.setDocument(document);
      } else {
        this.pending = document;
        if (this.isConnected) void this.editor;
      }
    }

    connectedCallback() {
      void this.editor;
    }

    attributeChangedCallback() {
      this.instance?.setReadOnly(this.hasAttribute("readonly"));
    }
  }

  customElements.define(name, Element);
};
