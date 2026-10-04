import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import type { TerrainModDefinition } from "@numeral-lord/content-schema";

const DATA_URL_PATTERN = /^data:image\/(png|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
const SAFE_SVG_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "title", "desc"
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "id", "class", "version", "xml:space", "width", "height", "viewbox", "preserveaspectratio",
  "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform",
  "clip-path", "clip-rule", "mask", "clippathunits", "gradientunits", "gradienttransform", "spreadmethod",
  "offset", "stop-color", "stop-opacity", "patternunits", "patterncontentunits", "patterntransform", "href", "xlink:href"
]);
const SAFE_SVG_STYLE_PROPERTIES = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity",
  "clip-path", "clip-rule", "mask", "stop-color", "stop-opacity"
]);

export interface StoredVisualAsset {
  readonly id: string;
  /** Relative to the relay's HTTP base path, e.g. assets/terrain/<sha256>.png. */
  readonly url: string;
}

export function workshopTerrainAssetDirectory(dataDirectory = defaultWorkshopDataDirectory()): string {
  return join(dataDirectory, "assets", "terrain");
}

export function defaultWorkshopDataDirectory(): string {
  return process.env.WORKSHOP_DATA_DIR ?? join(process.cwd(), "data", "workshop");
}

/** Persist deduplicated, validated artwork and return relative URL references. */
export async function persistTerrainVisualAssets(
  assets: TerrainModDefinition["visualAssets"],
  dataDirectory = defaultWorkshopDataDirectory()
): Promise<readonly StoredVisualAsset[]> {
  if (!assets?.length) return [];
  const directory = workshopTerrainAssetDirectory(dataDirectory);
  await mkdir(directory, { recursive: true });

  const urls: StoredVisualAsset[] = [];
  for (const asset of assets) {
    const match = DATA_URL_PATTERN.exec(asset.dataUrl);
    if (!match) throw new Error("Workshop terrain artwork format is invalid.");
    const bytes = Buffer.from(match[2]!, "base64");
    const extension = match[1] === "svg+xml" ? "svg" : match[1];
    if (extension === "svg") validateSafeSvg(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fileName = `${digest}.${extension}`;
    const path = join(directory, fileName);
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    urls.push({ id: asset.id, url: `assets/terrain/${fileName}` });
  }
  return urls;
}

/** Resolve only content-addressed artwork filenames; never accept paths from clients. */
export function getTerrainAssetFileName(value: string): string | undefined {
  const match = /^assets\/terrain\/([a-f0-9]{64}\.(?:png|webp|svg))$/.exec(value);
  return match?.[1];
}

export function getTerrainAssetContentType(fileName: string): "image/png" | "image/webp" | "image/svg+xml" | undefined {
  if (/^[a-f0-9]{64}\.png$/.test(fileName)) return "image/png";
  if (/^[a-f0-9]{64}\.webp$/.test(fileName)) return "image/webp";
  if (/^[a-f0-9]{64}\.svg$/.test(fileName)) return "image/svg+xml";
  return undefined;
}

/** Accept inert, self-contained vector art only; SVG is served solely as an image, never as markup. */
function validateSafeSvg(bytes: Buffer): void {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("SVG 必须是有效的 UTF-8 文件。"); }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("SVG 不允许声明外部实体或文档类型。");

  let parseError = "";
  const document = new DOMParser({ errorHandler: {
    warning: (message) => { parseError ||= String(message); },
    error: (message) => { parseError ||= String(message); },
    fatalError: (message) => { parseError ||= String(message); }
  } }).parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (parseError || document.doctype || !root || root.localName?.toLowerCase() !== "svg"
    || root.namespaceURI !== "http://www.w3.org/2000/svg") {
    throw new Error("SVG 结构无效；请上传带有标准 SVG 命名空间的自包含文件。");
  }
  for (const dimension of [root.getAttribute("width"), root.getAttribute("height")]) {
    const numericDimension = dimension && /^(\d+(?:\.\d+)?)(?:px)?$/.exec(dimension.trim());
    if (numericDimension && (Number(numericDimension[1]) < 1 || Number(numericDimension[1]) > 4096)) {
      throw new Error("SVG 画布尺寸不能超过 4096 像素。");
    }
  }
  const viewBox = root.getAttribute("viewBox");
  if (viewBox) {
    const dimensions = viewBox.trim().split(/[\s,]+/).map(Number);
    if (dimensions.length !== 4 || dimensions.some((dimension) => !Number.isFinite(dimension))
      || dimensions[2]! <= 0 || dimensions[3]! <= 0 || dimensions[2]! > 4096 || dimensions[3]! > 4096) {
      throw new Error("SVG 画布尺寸无效或过大。");
    }
  }

  let visitedNodes = 0;
  const ids = new Set<string>();
  const references: Array<{ readonly ownerId?: string; readonly targetId: string }> = [];
  const inspect = (node: Node, depth: number, parentOwnerId?: string): void => {
    if (++visitedNodes > 5000 || depth > 24) throw new Error("SVG 图案过于复杂，请简化后重新上传。");
    if (node.nodeType === 8) return;
    if (node.nodeType === 7) throw new Error("SVG 不允许外部样式或处理指令。");
    if (node.nodeType === 3 || node.nodeType === 4) return;
    if (node.nodeType !== 1) throw new Error("SVG 包含不支持的节点。");

    const element = node as Element;
    const tagName = element.localName?.toLowerCase() ?? element.tagName.toLowerCase();
    if (!SAFE_SVG_ELEMENTS.has(tagName)) throw new Error("SVG 只能使用静态矢量图形，不能包含脚本、动画或嵌入网页内容。");
    let ownerId = parentOwnerId;
    for (let index = 0; index < element.attributes.length; index += 1) {
      const attribute = element.attributes.item(index)!;
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name === "id") {
        if (!/^[A-Za-z_][\w:.-]{0,127}$/.test(value) || ids.has(value)) throw new Error("SVG 图层 ID 无效或重复。");
        ids.add(value);
        ownerId = value;
      }
      const safeNamespace = name.startsWith("xmlns:");
      const namespaceAttribute = name === "xmlns" || safeNamespace;
      const safeStyle = name === "style" && isSafeSvgStyle(value);
      if ((!SAFE_SVG_ATTRIBUTES.has(name) && !safeNamespace && !safeStyle) || name.startsWith("on")
        || (name === "xmlns" && value !== "http://www.w3.org/2000/svg")
        || (name === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink")
        || ((name === "href" || name === "xlink:href") && !/^#[A-Za-z_][\w:.-]*$/.test(value))
        || (!namespaceAttribute && (/javascript:|data:|https?:|@import/i.test(value)
          || /url\(\s*(['"]?)(?!#)/i.test(value)
          || /url\(\s*['"]?#(?![A-Za-z_][\w:.-]*['"]?\s*\))/i.test(value)))) {
        throw new Error("SVG 只允许使用本文件内的图形引用，不能加载外部资源或脚本。");
      }
      if (name === "href" || name === "xlink:href") references.push({ ...(ownerId ? { ownerId } : {}), targetId: value.slice(1) });
      for (const match of value.matchAll(/url\(\s*['"]?#([A-Za-z_][\w:.-]*)['"]?\s*\)/gi)) {
        references.push({ ...(ownerId ? { ownerId } : {}), targetId: match[1]! });
      }
    }
    for (let index = 0; index < element.childNodes.length; index += 1) inspect(element.childNodes.item(index)!, depth + 1, ownerId);
  };
  inspect(root, 0);
  const graph = new Map<string, string[]>();
  for (const reference of references) {
    if (!ids.has(reference.targetId)) throw new Error("SVG 只能引用文件中实际存在的图层。");
    if (reference.ownerId) graph.set(reference.ownerId, [...(graph.get(reference.ownerId) ?? []), reference.targetId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (depth > 64 || visiting.has(id)) throw new Error("SVG 图层引用存在循环或嵌套过深。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const targetId of graph.get(id) ?? []) visit(targetId, depth + 1);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id, 0);
}

function isSafeSvgStyle(style: string): boolean {
  return style.split(";").every((declaration) => {
    if (!declaration.trim()) return true;
    const separator = declaration.indexOf(":");
    if (separator < 1) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    return SAFE_SVG_STYLE_PROPERTIES.has(property) && Boolean(value)
      && !/javascript:|data:|https?:|@import|expression\s*\(/i.test(value)
      && !/url\(\s*(['"]?)(?!#)/i.test(value)
      && !/url\(\s*['"]?#(?![A-Za-z_][\w:.-]*['"]?\s*\))/i.test(value);
  });
}

function isCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
