// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@segmsh/core";
import { Editor, createEditor, defineElement } from "../src/index.js";

const sampleDocument = (): Document => ({
  tree: {
    type: "root",
    children: [
      { type: "element", tagName: "h1", properties: { id: "top" }, children: [{ type: "segment", id: "s1" }] },
      { type: "text", value: "\n" },
      { type: "element", tagName: "p", properties: { className: ["lead"] }, children: [{ type: "segment", id: "s2" }] },
      { type: "element", tagName: "script", properties: {}, children: [{ type: "text", value: "alert(1)" }] },
      { type: "comment", value: "hidden" },
      {
        type: "element",
        tagName: "table",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "tr",
            properties: {},
            children: [
              { type: "element", tagName: "td", properties: {}, children: [{ type: "text", value: "key" }] },
              { type: "element", tagName: "td", properties: {}, children: [{ type: "segment", id: "s3" }] },
            ],
          },
        ],
      },
      { type: "element", tagName: "p", properties: {}, children: [{ type: "segment", id: "s1" }] },
    ],
  } as Document["tree"],
  segments: [
    { id: "s1", text: "Title" },
    { id: "s2", text: "Read {a0}the {b1}docs{/b1}{/a0}{img2}", tags: { a0: { href: "javascript:alert(1)", title: "t" }, img2: { src: "x.png", onerror: "alert(1)" } } },
    { id: "s3", text: "Value", metadata: { key: "a.b" } },
    { id: "s1", text: "Title" },
  ],
});

const field = (editor: Editor) => editor.getSegmentElements(editor.activeSegmentId!)[0];

// Segments open on mousedown, like a real press
const press = (target: Element) =>
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));

const key = (target: Element, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

// Replaces the field content as if the user typed it
const type = (element: HTMLElement, ...nodes: (string | Node)[]) => {
  element.replaceChildren(...nodes);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

describe("rendering", () => {
  it("renders the tree with segment markup, sanitized", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const view = container.querySelector(".sm-doc")!;

    expect(view.querySelector("script")).toBeNull();
    expect(view.querySelector("h1")!.getAttribute("id")).toBeNull();
    expect(view.querySelector("h1")!.dataset.id).toBe("top");
    expect(view.querySelector("p")!.dataset.class).toBe("lead");

    const [s2] = editor.getSegmentElements("s2");
    expect(s2.innerHTML).toBe('Read <a data-tag="a" title="t" data-marker="a0">the <b data-tag="b" data-marker="b1">docs</b></a><img data-tag="img" src="x.png" data-marker="img2">');
  });

  it("returns the same document when nothing was edited", () => {
    const input = sampleDocument();
    const editor = createEditor(container, { document: input });

    expect(editor.getDocument()).toEqual(input);
    expect(editor.getDocument()).not.toBe(input);
  });

  it("exposes blocks keyed by tree path, table cells as their row", () => {
    const editor = createEditor(container, { document: sampleDocument() });

    expect(editor.getBlocks().map((block) => [block.key, block.element.tagName, block.segmentIds])).toEqual([
      ["0", "H1", ["s1"]],
      ["2", "P", ["s2"]],
      ["5.0", "TR", ["s3"]],
      ["6", "P", ["s1"]],
    ]);
  });

  it("renders source-file trees as source", () => {
    createEditor(container, {
      document: {
        tree: { type: "root", children: [{ type: "text", value: "name = " }, { type: "element", tagName: "value", properties: {}, children: [{ type: "segment", id: "a" }] }] } as Document["tree"],
        segments: [{ id: "a", text: "apple" }],
      },
    });

    expect(container.querySelector(".sm-doc")!.classList.contains("sm-source")).toBe(true);
    expect(container.querySelector(".sm-doc")!.textContent).toBe("name = apple");
  });
});

describe("editing", () => {
  it("opens a segment as text with marker chips", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onFocus = vi.fn();
    editor.on("focus", onFocus);

    press(editor.getSegmentElements("s2")[0]);

    const element = field(editor);
    expect(editor.activeSegmentId).toBe("s2");
    expect(element.getAttribute("contenteditable")).toBe("true");
    expect([...element.querySelectorAll(".sm-chip")].map((chip) => (chip as HTMLElement).dataset.marker)).toEqual(["a0", "b1", "/b1", "/a0", "img2"]);
    expect(onFocus).toHaveBeenCalledWith({ id: "s2", segment: expect.objectContaining({ id: "s2" }) });
    // The open segment's block is marked so hover and highlights stay off it
    expect(element.parentElement!.classList.contains("sm-editing-block")).toBe(true);
    editor.cancel();
    expect(container.querySelectorAll(".sm-editing-block")).toHaveLength(0);
    press(editor.getSegmentElements("s2")[0]);

    // Labels come from CSS so double-click word selection doesn't swallow the chips
    expect(element.querySelector(".sm-chip")!.textContent).toBe("");
    expect((element.querySelector(".sm-chip") as HTMLElement).dataset.label).toBe("a0");
  });

  it("commits with Ctrl+Enter, emits change and moves to the next segment", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onChange = vi.fn();
    const onInput = vi.fn();
    editor.on("change", onChange);
    editor.on("input", onInput);

    editor.focusSegment("s1");
    type(field(editor), "Titel");
    expect(onInput).toHaveBeenLastCalledWith({ id: "s1", text: "Titel" });

    key(field(editor), { key: "Enter", ctrlKey: true });

    expect(onChange).toHaveBeenCalledWith({ id: "s1", text: "Titel", previous: "Title", segment: { id: "s1", text: "Titel" } });
    expect(editor.activeSegmentId).toBe("s2");
    // Both occurrences of the duplicated segment show the edit
    expect(editor.getSegmentElements("s1").map((element) => element.textContent)).toEqual(["Titel", "Titel"]);
    expect(editor.getDocument().segments.filter((segment) => segment.id === "s1").map((segment) => segment.text)).toEqual(["Titel", "Titel"]);
  });

  it("pressing another segment saves the open one and opens it", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onChange = vi.fn();
    editor.on("change", onChange);

    press(editor.getSegmentElements("s1")[0]);
    type(field(editor), "Titel");
    press(editor.getSegmentElements("s3")[0]);

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", text: "Titel" }));
    expect(editor.activeSegmentId).toBe("s3");
    expect(container.querySelectorAll(".sm-toolbar")).toHaveLength(1);
  });

  it("saves with the Save button without opening the next segment", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onChange = vi.fn();
    editor.on("change", onChange);

    editor.focusSegment("s1");
    type(field(editor), "Titel");
    const save = [...container.querySelectorAll(".sm-toolbar button")].find((element) => element.textContent === "Save") as HTMLButtonElement;
    save.click();

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", text: "Titel" }));
    expect(editor.activeSegmentId).toBeNull();
    expect(container.querySelector(".sm-toolbar")).toBeNull();
  });

  it("keeps markers when the text around them changes", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    editor.focusSegment("s2");

    const element = field(editor);
    const chips = [...element.querySelectorAll(".sm-chip")];
    type(element, "Lies ", chips[0], "die ", chips[1], "Doku", chips[2], chips[3], chips[4]);
    expect(editor.commit()).toBe(true);

    const segment = editor.getDocument().segments[1];
    expect(segment.text).toBe("Lies {a0}die {b1}Doku{/b1}{/a0}{img2}");
    expect(segment.tags).toEqual(sampleDocument().segments[1].tags);
  });

  it("refuses to commit broken markers and stays open", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onInvalid = vi.fn();
    const onChange = vi.fn();
    editor.on("invalid", onInvalid);
    editor.on("change", onChange);

    editor.focusSegment("s2");
    const element = field(editor);
    const chips = [...element.querySelectorAll(".sm-chip")];
    type(element, chips[0], "x", chips[1], "y");

    expect(editor.commit()).toBe(false);
    expect(editor.activeSegmentId).toBe("s2");
    expect(element.classList.contains("sm-invalid")).toBe(true);
    expect(onInvalid.mock.calls[0][0].errors.map((error: { code: string }) => error.code)).toEqual(["unclosed", "unclosed"]);
    expect(container.querySelector(".sm-toolbar-error")!.textContent).toContain("{b1} is not closed");
    expect(onChange).not.toHaveBeenCalled();

    // Opening another segment is blocked until fixed
    press(editor.getSegmentElements("s3")[0]);
    expect(editor.activeSegmentId).toBe("s2");
  });

  it("offers dropped markers for re-insertion", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    editor.focusSegment("s2");
    type(field(editor), "nothing");

    const buttons = [...container.querySelectorAll(".sm-toolbar .sm-chip")] as HTMLButtonElement[];
    expect(buttons.map((button) => button.textContent)).toEqual(["a0", "b1", "img2"]);

    // Wrap "thing" in the restored pair
    const range = document.createRange();
    range.setStart(field(editor).firstChild!, 2);
    range.setEnd(field(editor).firstChild!, 7);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);

    buttons[1].click();
    expect(editor.commit()).toBe(true);
    expect(editor.getSegment("s2")!.text).toBe("no{b1}thing{/b1}");

    // With a collapsed caret an empty pair is inserted
    editor.focusSegment("s2");
    buttons.splice(0);
    (container.querySelector(".sm-toolbar .sm-chip") as HTMLButtonElement).click();
    expect(editor.commit()).toBe(true);
    expect(editor.getSegment("s2")!.text).toBe("no{b1}thing{/b1}{a0}{/a0}");
  });

  it("cancels with Escape", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onBlur = vi.fn();
    editor.on("blur", onBlur);

    editor.focusSegment("s3");
    type(field(editor), "changed");
    key(field(editor), { key: "Escape" });

    expect(editor.activeSegmentId).toBeNull();
    expect(editor.getSegment("s3")!.text).toBe("Value");
    expect(editor.getSegmentElements("s3")[0].textContent).toBe("Value");
    expect(onBlur).toHaveBeenCalledOnce();
    // Nothing left focused or selected on the closed segment
    expect(document.activeElement).not.toBe(editor.getSegmentElements("s3")[0]);
    expect(document.getSelection()!.rangeCount).toBe(0);
  });

  it("runs host actions against the open field", () => {
    const editor = createEditor(container, {
      document: sampleDocument(),
      actions: [{ label: "Translate", run: ({ segment, setText }) => setText(segment.text.toUpperCase()) }],
    });

    editor.focusSegment("s3");
    const button = [...container.querySelectorAll(".sm-toolbar button")].find((element) => element.textContent === "Translate") as HTMLButtonElement;
    button.click();
    editor.commit();

    expect(editor.getSegment("s3")!.text).toBe("VALUE");
  });

  it("updates segments programmatically without a change event", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onChange = vi.fn();
    editor.on("change", onChange);

    expect(editor.setSegment("s3", "Wert")).toBe(true);
    expect(editor.getSegmentElements("s3")[0].textContent).toBe("Wert");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not edit in read-only mode but still reports focus", () => {
    const editor = createEditor(container, { document: sampleDocument(), readOnly: true });
    const onFocus = vi.fn();
    editor.on("focus", onFocus);

    const element = editor.getSegmentElements("s3")[0];
    press(element);
    element.focus();

    expect(editor.activeSegmentId).toBeNull();
    expect(element.getAttribute("contenteditable")).toBeNull();
    expect(onFocus).toHaveBeenCalledWith({ id: "s3", segment: expect.objectContaining({ id: "s3" }) });
  });

  it("applies segmentClass and refreshes it", () => {
    const done = new Set<string>();
    const editor = createEditor(container, {
      document: sampleDocument(),
      segmentClass: (segment) => (done.has(segment.id) ? "is-done" : "is-todo"),
    });
    const [element] = editor.getSegmentElements("s3");

    expect(element.classList.contains("is-todo")).toBe(true);
    done.add("s3");
    editor.refresh("s3");
    expect(element.classList.contains("is-todo")).toBe(false);
    expect(element.classList.contains("is-done")).toBe(true);
  });

  it("highlights all occurrences of a segment", () => {
    const editor = createEditor(container, { document: sampleDocument() });

    editor.highlight("s1");
    expect(editor.getSegmentElements("s1").every((element) => element.classList.contains("sm-highlight"))).toBe(true);
    editor.highlight(null);
    expect(container.querySelectorAll(".sm-highlight")).toHaveLength(0);
  });

  it("treats the whole block as the segment for hover and press", () => {
    const editor = createEditor(container, { document: sampleDocument() });
    const onHover = vi.fn();
    editor.on("hover", onHover);

    // Between lines the pointer is over the paragraph, not the text
    const paragraph = editor.getSegmentElements("s2")[0].parentElement!;
    paragraph.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(onHover).toHaveBeenLastCalledWith({ id: "s2" });

    // The key cell of a key / value row opens its value
    press(container.querySelector("td")!);
    expect(editor.activeSegmentId).toBe("s3");
  });

  it("highlights the whole block: the container, or every cell of a one-segment row", () => {
    const editor = createEditor(container, { document: sampleDocument() });

    editor.highlight("s2", "peer");
    expect([...container.querySelectorAll(".peer")].map((element) => element.tagName)).toEqual(["P", "SPAN"]);

    editor.highlight("s3", "peer");
    expect([...container.querySelectorAll(".peer")].map((element) => element.tagName)).toEqual(["TD", "TD", "SPAN"]);
  });
});

describe("custom element", () => {
  it("loads a document and re-dispatches events", () => {
    defineElement();
    const element = document.createElement("segmsh-editor") as HTMLElement & { value: Document; editor: Editor };
    element.value = sampleDocument();
    container.appendChild(element);

    const onChange = vi.fn();
    element.addEventListener("segment-change", (event) => onChange((event as CustomEvent).detail));

    element.editor.focusSegment("s3");
    type(field(element.editor), "Wert");
    element.editor.commit();

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: "s3", text: "Wert" }));
    expect(element.value.segments[2].text).toBe("Wert");
  });
});
