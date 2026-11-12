import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import ts from "typescript";

const source = await readFile(new URL("../app/image-drop.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { hasImageDropData, getImageDropEffect, readImageDrop } =
  await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const transfer = (payloads = {}, files = []) => ({
  types: files.length ? ["Files", ...Object.keys(payloads)] : Object.keys(payloads),
  files,
  getData: (type) => payloads[type] || "",
});

test("external imports negotiate every allowed drag operation without ever moving the source", () => {
  const expected = {
    none: "none", copy: "copy", copyLink: "copy", copyMove: "copy", link: "link",
    linkMove: "link", move: "none", all: "copy", uninitialized: "copy",
  };
  for (const [effectAllowed, dropEffect] of Object.entries(expected)) {
    const data = Object.freeze({ effectAllowed });
    const result = getImageDropEffect(data);
    assert.equal(result, dropEffect, effectAllowed);
    assert.notEqual(result, "move", "Importing must never tell a browser or file manager to remove the source");
    assert.equal(data.effectAllowed, effectAllowed, "Negotiation must respect, not rewrite, the source's allowed operations");
  }
});

function inertHtmlAdapter(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const created = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, "template");
        created.push(tag);
        let parsed;
        return {
          set innerHTML(html) {
            parsed = new DOMParser().parseFromString(`<test-fragment>${html}</test-fragment>`, "text/html");
          },
          get content() {
            return {
              querySelectorAll(selector) {
                assert.equal(selector, "img");
                return parsed.getElementsByTagName("img");
              },
              querySelector(selector) {
                assert.equal(selector, "base[href]");
                return Array.from(parsed.getElementsByTagName("base"))
                  .find((element) => element.hasAttribute("href"));
              },
            };
          },
        };
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  return created;
}

test("external image drop formats are recognized case-insensitively, internal board drags are excluded", () => {
  for (const type of ["Files", "text/uri-list", "text/plain", "text/html", "text/x-moz-url", "text/x-moz-url-data"]) {
    assert.equal(hasImageDropData({ types: [type] }), true, type);
    assert.equal(hasImageDropData({ types: [type.toUpperCase()] }), true, type);
  }
  for (const types of [[], ["application/json"], ["text/x-imagestorage-board", "text/plain"],
    ["TEXT/X-IMAGESTORAGE-BOARD", "Files", "text/html"]]) {
    assert.equal(hasImageDropData({ types }), false);
  }
});

test("native files take precedence without reading HTML or URLs", () => {
  const files = [new File(["image"], "drawing.png", { type: "image/png" }), new File(["other"], "second.jpg")];
  const data = { files, getData() { throw new Error("File drop must not inspect text"); } };
  const result = readImageDrop(data);
  assert.deepEqual(result, { files });
  assert.notEqual(result.files, files);
  assert.equal(result.files[0], files[0]);
});

test("a native browser link shortcut uses the accompanying HTML image instead of importing the shortcut file", (t) => {
  inertHtmlAdapter(t);
  // Sanitized shape captured from a real Firefox-to-Electron Pinterest drop:
  // a virtual .url File with no MIME/path plus HTML, URI and plain text.
  const shortcut = new File(["[InternetShortcut]\r\nURL=https://www.pinterest.com/pin/123/\r\n"], "画像の内容：Example on X.url");
  const image = "https://i.pinimg.com/236x/aa/bb/cc/reference.jpg";
  const data = transfer({
    "text/plain": "https://www.pinterest.com/pin/123/",
    "text/uri-list": "https://www.pinterest.com/pin/123/",
    "text/html": `<a href="https://www.pinterest.com/pin/123/"><div><img draggable="false" src="${image}" /></div></a>`,
  }, [shortcut]);
  assert.equal(shortcut.type, "");
  assert.equal(hasImageDropData(data), true);
  assert.deepEqual(readImageDrop(data), { files: [], url: image });
});

test("known link shortcuts are case-insensitive and fall back to supplied browser URL formats", () => {
  const url = "https://www.pinterest.com/pin/123/";
  for (const files of [
    [new File(["shortcut"], "reference.URL")],
    [new File(["shortcut"], "reference.WeBlOc")],
    [new File(["shortcut"], "first.url"), new File(["shortcut"], "second.webloc")],
  ]) {
    for (const type of ["text/uri-list", "text/plain", "text/x-moz-url-data", "text/x-moz-url"]) {
      const value = type === "text/x-moz-url" ? `${url}\nReference caption` : url;
      assert.deepEqual(readImageDrop(transfer({ [type]: value }, files)), { files: [], url });
    }
  }
});

test("real images, mixed drops and unknown files retain file precedence even with a usable browser URL", () => {
  const shortcut = new File(["shortcut"], "reference.url");
  const image = new File(["image"], "drawing.png");
  const unknown = new File(["unknown bytes"], "reference");
  const ambiguous = new File(["unknown bytes"], "reference.bin", { type: "application/internet-shortcut" });
  for (const files of [[image], [shortcut, image], [image, shortcut], [unknown], [unknown, shortcut], [ambiguous]]) {
    let reads = 0;
    const result = readImageDrop({ files, getData() { reads++; return "https://cdn.test/image.png"; } });
    assert.deepEqual(result, { files });
    assert.equal(reads, 0, "Only an entirely known-shortcut drop may bypass file import");
    assert.equal(result.files[0], files[0]);
  }
  assert.equal(image.type, "", "A missing image MIME type is not evidence of a link shortcut");
});

test("link shortcuts without a readable accompanying URL produce an error instead of entering image decoding", (t) => {
  inertHtmlAdapter(t);
  const files = [new File(["[InternetShortcut]\r\nURL=https://hidden.test/image.png"], "reference.url")];
  for (const payloads of [{}, { "text/plain": "Image caption" },
    { "text/uri-list": "javascript:alert(1)" }, { "text/html": '<img src="data:text/html;base64,AA==" />' }]) {
    assert.deepEqual(readImageDrop(transfer(payloads, files)), { files: [], error: "empty" });
  }
  assert.deepEqual(readImageDrop(transfer({ "text/html": '<img src="blob:https://site.test/private" />' }, files)),
    { files: [], error: "browser-only" });
});

test("URI lists skip comments and invalid entries, Firefox reads only the URL line", () => {
  assert.deepEqual(readImageDrop(transfer({ "text/uri-list": "# comment\r\n\nnot a URL\nhttps://cdn.test/image.png\r\nhttps://other.test/" })),
    { files: [], url: "https://cdn.test/image.png" });
  for (const type of ["text/x-moz-url", "text/x-moz-url-data"]) {
    assert.deepEqual(readImageDrop(transfer({ [type]: "https://cdn.test/image.png\nImage caption with spaces" })),
      { files: [], url: "https://cdn.test/image.png" });
    assert.deepEqual(readImageDrop(transfer({ [type]: "not a URL\nhttps://caption.test/image.png" })),
      { files: [], error: "empty" });
  }
});

test("plain image URLs, image data, file URLs and Windows paths remain supported", () => {
  for (const value of ["https://cdn.test/image.png?size=large", "http://cdn.test/image.jpg", "data:image/png;base64,aGVsbG8=",
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>", "file:///C:/Pictures/example.png",
    "C:\\My Pictures\\example.png", "D:/My Pictures/example.jpg", "\\\\server\\Pictures\\example.png"]) {
    assert.deepEqual(readImageDrop(transfer({ "text/plain": `  ${value}  ` })), { files: [], url: value });
  }
});

test("Pinterest-style linked image HTML wins over the pin page URL and retains its actual src", (t) => {
  const created = inertHtmlAdapter(t);
  const image = "https://i.pinimg.com/736x/aa/bb/example.jpg";
  const result = readImageDrop(transfer({
    "text/html": `<a href="https://www.pinterest.com/pin/123/"><img src="${image}" srcset="https://i.pinimg.com/originals/other.jpg 2x" /></a>`,
    "text/uri-list": "https://www.pinterest.com/pin/123/",
    "text/plain": "https://www.pinterest.com/pin/123/",
  }));
  assert.deepEqual(result, { files: [], url: image });
  assert.deepEqual(created, ["template"]);
});

test("HTML-only and lazy image drags are parsed as inert template contents", (t) => {
  inertHtmlAdapter(t);
  const url = "https://cdn.test/actual.png";
  for (const html of [`<img src="${url}" />`, `<img data-src="${url}" />`,
    `<img src="" data-src="${url}" />`, `<img src="javascript:alert(1)" data-src="${url}" />`,
    `<script>throw new Error('must remain inert')</script><img src="${url}" onerror="throw new Error('inert')" />`]) {
    assert.deepEqual(readImageDrop(transfer({ "text/html": html })), { files: [], url });
  }
});

test("relative HTML images resolve against explicit base, CF_HTML source, URI or Firefox base", (t) => {
  inertHtmlAdapter(t);
  const cases = [
    [{ "text/html": '<base href="https://cdn.test/assets/" /><img src="image.png" />' }, "https://cdn.test/assets/image.png"],
    [{ "text/html": 'Version:1.0\r\nSourceURL:https://site.test/articles/page.html\r\n<img src="../image.png" />' }, "https://site.test/image.png"],
    [{ "text/html": 'SourceURL:https://site.test/articles/page.html\r\n<base href="../assets/" /><img src="image.png" />' }, "https://site.test/assets/image.png"],
    [{ "text/html": '<img src="../image.png" />', "text/uri-list": "# source\nhttps://site.test/posts/page" }, "https://site.test/image.png"],
    [{ "text/html": '<img src="image.png" />', "text/x-moz-url": "https://site.test/posts/page\nCaption" }, "https://site.test/posts/image.png"],
    [{ "text/html": '<img src="//cdn.test/image.png" />', "text/x-moz-url-data": "https://site.test/page" }, "https://cdn.test/image.png"],
    [{ "text/html": '<img src="image.png" />', "text/uri-list": "file:///C:/Pictures/page.html" }, "file:///C:/Pictures/image.png"],
    [{ "text/html": '<img src="image.png" />' }, undefined],
  ];
  for (const [payloads, url] of cases) {
    assert.deepEqual(readImageDrop(transfer(payloads)), url ? { files: [], url } : { files: [], error: "empty" });
  }
});

test("browser-private images return an explanation instead of importing their linked page", (t) => {
  inertHtmlAdapter(t);
  const blob = "blob:https://site.test/2b7fc";
  for (const payloads of [
    { "text/plain": blob }, { "text/uri-list": blob }, { "text/x-moz-url": `${blob}\nCaption` },
    { "text/html": `<a href="https://site.test/post"><img src="${blob}" /></a>`, "text/uri-list": "https://site.test/post" },
  ]) assert.deepEqual(readImageDrop(transfer(payloads)), { files: [], error: "browser-only" });
  assert.deepEqual(readImageDrop(transfer({ "text/html": `<img src="${blob}" data-src="https://cdn.test/image.png" />` })),
    { files: [], url: "https://cdn.test/image.png" });
  assert.deepEqual(readImageDrop(transfer({ "text/uri-list": `${blob}\nhttps://cdn.test/image.png` })),
    { files: [], url: "https://cdn.test/image.png" });
});

test("unsupported schemes, non-image data, captions, markup and control characters are rejected", (t) => {
  inertHtmlAdapter(t);
  const rejected = ["javascript:alert(1)", "data:text/html,<img src=x>", "data:application/octet-stream;base64,AA==",
    "ftp://site.test/image.png", "mailto:someone@example.com", "/relative/image.png", "Some image https://cdn.test/image.png",
    "https://cdn.test/image.png another caption", "https://cdn.test/one.png\nhttps://cdn.test/two.png", "https://cdn.test/\u0000image.png"];
  for (const value of rejected) {
    assert.deepEqual(readImageDrop(transfer({ "text/plain": value })), { files: [], error: "empty" }, value);
  }
  for (const html of ['<img src="javascript:alert(1)" />', '<img src="data:text/html;base64,AA==" />',
    '<base href="javascript:alert(1)" /><img src="relative.png" />', '<img src="java&#x73;cript:alert(1)" />']) {
    assert.deepEqual(readImageDrop(transfer({ "text/html": html })), { files: [], error: "empty" });
  }
});

test("empty, unavailable and unreadable transfer payloads fail without throwing", () => {
  assert.deepEqual(readImageDrop(transfer()), { files: [], error: "empty" });
  assert.deepEqual(readImageDrop({ files: [], getData() { throw new Error("Unavailable transfer"); } }), { files: [], error: "empty" });
  assert.deepEqual(readImageDrop(transfer({ "text/html": '<img src="https://cdn.test/image.png" />' })), { files: [], error: "empty" });
});
