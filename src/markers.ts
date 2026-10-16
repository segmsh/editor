// Same marker shapes as the segmsh processors, e.g. {b0}…{/b0}, {img1}, {h20}…{/h20}
const MARKER_REGEXP: RegExp = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*?)(\d+)$/;
const HEADING_MARKER_REGEXP: RegExp = /^(\/?)(h[1-6])(\d+)$/;

export const VOID_TAGS: string[] = [
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
];

export interface TextToken {
  type: "text";
  value: string;
}

export interface MarkerToken {
  type: "marker";
  // Marker key without the slash, e.g. "b0"; also the key into segment tags
  name: string;
  tagName: string;
  closing: boolean;
}

export type Token = TextToken | MarkerToken;

// "pair" markers wrap content ({b0}…{/b0}), "void" markers stand alone ({img0})
export type MarkerKind = "pair" | "void";

export interface MarkerError {
  code: "unknown" | "duplicate" | "unclosed" | "unopened" | "nesting";
  marker: string;
  message: string;
}

export const parseMarker = (
  marker: string,
): Omit<MarkerToken, "type"> | null => {
  const match = HEADING_MARKER_REGEXP.exec(marker) ?? MARKER_REGEXP.exec(marker);
  if (!match) return null;

  return {
    name: marker.replace(/^\//, ""),
    tagName: match[2],
    closing: match[1] === "/",
  };
};

export const tokenize = (value: string): Token[] => {
  const tokens: Token[] = [];
  let buffer = "";

  for (let i = 0; i < value.length; i++) {
    const closingIndex = value[i] === "{" ? value.indexOf("}", i + 1) : -1;
    const marker = closingIndex > 0 ? value.substring(i + 1, closingIndex) : "";
    const parsed = marker ? parseMarker(marker) : null;

    if (!parsed) {
      buffer += value[i];
      continue;
    }

    if (buffer) {
      tokens.push({ type: "text", value: buffer });
      buffer = "";
    }

    tokens.push({ type: "marker", ...parsed });
    i = closingIndex;
  }

  if (buffer) tokens.push({ type: "text", value: buffer });

  return tokens;
};

export const markerString = (token: MarkerToken): string =>
  `{${token.closing ? "/" : ""}${token.name}}`;

export const stringify = (tokens: Token[]): string =>
  tokens
    .map((token) => (token.type === "text" ? token.value : markerString(token)))
    .join("");

// Markers a segment is allowed to contain, with their kind and tag name
export const markerKinds = (
  value: string,
): Map<string, { kind: MarkerKind; tagName: string }> => {
  const tokens = tokenize(value);
  const kinds = new Map<string, { kind: MarkerKind; tagName: string }>();

  for (const token of tokens) {
    if (token.type !== "marker" || token.closing) continue;

    const closed = tokens.some(
      (other) =>
        other.type === "marker" && other.closing && other.name === token.name,
    );
    const kind = closed && !VOID_TAGS.includes(token.tagName) ? "pair" : "void";

    kinds.set(token.name, { kind, tagName: token.tagName });
  }

  return kinds;
};

export const validate = (
  value: string,
  allowed: Map<string, { kind: MarkerKind }>,
): MarkerError[] => {
  const errors: MarkerError[] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  for (const token of tokenize(value)) {
    if (token.type !== "marker") continue;

    const marker = markerString(token);
    const kind = allowed.get(token.name)?.kind;

    if (!kind) {
      errors.push({ code: "unknown", marker, message: `Unknown marker ${marker}` });
      continue;
    }

    const key = (token.closing ? "/" : "") + token.name;

    if (seen.has(key)) {
      errors.push({ code: "duplicate", marker, message: `Duplicate marker ${marker}` });
      continue;
    }

    seen.add(key);

    if (kind === "void") {
      if (token.closing) {
        errors.push({ code: "unopened", marker, message: `Unexpected marker ${marker}` });
      }
    } else if (!token.closing) {
      stack.push(token.name);
    } else if (!stack.includes(token.name)) {
      errors.push({ code: "unopened", marker, message: `${marker} has no opening marker` });
    } else if (stack[stack.length - 1] !== token.name) {
      errors.push({ code: "nesting", marker, message: `${marker} closes out of order` });
      stack.splice(stack.lastIndexOf(token.name), 1);
    } else {
      stack.pop();
    }
  }

  for (const name of stack) {
    errors.push({ code: "unclosed", marker: `{${name}}`, message: `{${name}} is not closed` });
  }

  return errors;
};

// Allowed markers that are absent from the value, so they can be offered for re-insertion
export const missingMarkers = (
  value: string,
  allowed: Map<string, { kind: MarkerKind; tagName: string }>,
): string[] => {
  const present = new Set(
    tokenize(value)
      .filter((token): token is MarkerToken => token.type === "marker")
      .map((token) => token.name),
  );

  return [...allowed.keys()].filter((name) => !present.has(name));
};
