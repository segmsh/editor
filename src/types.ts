import type { Document, Segment } from "@segmsh/core";
import type { MarkerError } from "./markers.js";

export type { Document, Segment, MarkerError };

export interface ActionContext {
  segment: Segment;
  // Current, uncommitted text of the field
  text: string;
  // Replaces the field content, e.g. with a machine translation suggestion
  setText(text: string): void;
}

export interface EditorAction {
  label: string;
  title?: string;
  run(context: ActionContext): void;
}

export interface EditorOptions {
  document?: Document;
  readOnly?: boolean;
  // Buttons shown in the toolbar of the segment being edited
  actions?: EditorAction[];
  // Hide the toolbar entirely (keyboard only)
  toolbar?: boolean;
  // Extra classes for a segment, e.g. a translation status; re-applied on refresh()
  segmentClass?: (segment: Segment) => string | string[] | null | undefined;
}

export interface EditorEvents {
  // A segment became active (editing in edit mode, selected in read-only mode)
  focus: { id: string; segment: Segment };
  blur: { id: string; segment: Segment };
  // The field content changed while editing; not committed yet
  input: { id: string; text: string };
  // A user edit was committed
  change: { id: string; text: string; previous: string; segment: Segment };
  // Commit was refused because markers are broken
  invalid: { id: string; text: string; errors: MarkerError[] };
  hover: { id: string | null };
}

export type EditorEventName = keyof EditorEvents;

export interface Block {
  // Tree path of the element, e.g. "0.3.1"; equal for the same element of two documents sharing a tree
  key: string;
  element: HTMLElement;
  segmentIds: string[];
}
