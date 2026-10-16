import { describe, expect, it } from "vitest";
import { markerKinds, missingMarkers, stringify, tokenize, validate } from "../src/markers.js";

describe("tokenize", () => {
  it("splits text and markers and round-trips", () => {
    const text = "Read {a0}the {b1}docs{/b1}{/a0}{img2} now";
    const tokens = tokenize(text);

    expect(tokens.map((token) => (token.type === "text" ? token.value : token.name))).toEqual([
      "Read ", "a0", "the ", "b1", "docs", "b1", "a0", "img2", " now",
    ]);
    expect(stringify(tokens)).toBe(text);
  });

  it("reads heading markers like the html processor", () => {
    const [marker] = tokenize("{h20}");
    expect(marker).toMatchObject({ type: "marker", name: "h20", tagName: "h2" });
  });

  it("keeps braces that are not markers as text", () => {
    expect(tokenize("{name} and {} and {0}")).toEqual([
      { type: "text", value: "{name} and {} and {0}" },
    ]);
  });
});

describe("markerKinds", () => {
  it("tells pairs from void markers", () => {
    const kinds = markerKinds("{b0}x{/b0}{img1}{br2}{a3}");

    expect(Object.fromEntries([...kinds].map(([key, value]) => [key, value.kind]))).toEqual({
      b0: "pair",
      img1: "void",
      br2: "void",
      a3: "void",
    });
  });
});

describe("validate", () => {
  const allowed = markerKinds("{b0}a{i1}b{/i1}{/b0}{img2}");

  it("accepts valid text and dropped markers", () => {
    expect(validate("{b0}x{/b0}", allowed)).toEqual([]);
    expect(validate("plain", allowed)).toEqual([]);
    expect(validate("{i1}x{/i1} {img2} {b0}y{/b0}", allowed)).toEqual([]);
  });

  it("reports unknown, duplicate, unclosed, unopened and misnested markers", () => {
    const codes = (text: string) => validate(text, allowed).map((error) => error.code);

    expect(codes("{x9}")).toEqual(["unknown"]);
    expect(codes("{img2}{img2}")).toEqual(["duplicate"]);
    expect(codes("{b0}x")).toEqual(["unclosed"]);
    expect(codes("x{/b0}")).toEqual(["unopened"]);
    expect(codes("{b0}{i1}x{/b0}{/i1}")).toEqual(["nesting"]);
    expect(codes("{/img2}")).toEqual(["unopened"]);
  });
});

describe("missingMarkers", () => {
  it("lists allowed markers absent from the text", () => {
    const allowed = markerKinds("{b0}a{/b0}{img1}");
    expect(missingMarkers("{b0}x{/b0}", allowed)).toEqual(["img1"]);
  });
});
