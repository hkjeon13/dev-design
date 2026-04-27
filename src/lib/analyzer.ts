import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { AnalysisResult, ProjectNode, SourceFile, SourceMapping } from "./types";

const REACT_EXTENSIONS = [".tsx", ".jsx"];

interface JsxElementRecord {
  id: string;
  displayName: string;
  sourceFile: string;
  start: number;
  end: number;
  parentId: string | null;
  childrenIds: string[];
}

export function isReactFile(path: string): boolean {
  return REACT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

export function isStyleFile(path: string): boolean {
  return /\.(module\.)?(css|scss|sass|less)$/.test(path);
}

export function analyzeSourceFiles(files: SourceFile[]): AnalysisResult {
  const nodes: ProjectNode[] = [];
  const mappings: SourceMapping[] = [];
  const warnings: string[] = [];
  const nextFiles = files.map((file) => {
    if (!isReactFile(file.path)) {
      return file;
    }
    try {
      return {
        ...file,
        content: instrumentReactSource(file.path, file.content),
      };
    } catch (error) {
      warnings.push(`${file.path}: ${String(error)}`);
      return file;
    }
  });

  for (const file of nextFiles) {
    if (isReactFile(file.path)) {
      const fileNode = makeFileNode(file);
      nodes.push(fileNode);
      try {
        const elements = collectJsxElements(file.path, file.content);
        for (const element of elements) {
          const node: ProjectNode = {
            id: element.id,
            type: "jsx_element",
            displayName: element.displayName,
            sourceFile: element.sourceFile,
            sourceRange: { start: element.start, end: element.end },
            parentId: element.parentId ?? fileNode.id,
            childrenIds: element.childrenIds,
            depth: 1,
          };
          nodes.push(node);
          mappings.push({
            domId: element.id,
            nodeId: element.id,
            filePath: element.sourceFile,
            start: element.start,
            end: element.end,
          });
        }
        fileNode.childrenIds = elements
          .filter((element) => element.parentId === null)
          .map((element) => element.id);
      } catch (error) {
        warnings.push(`${file.path}: ${String(error)}`);
      }
    } else if (isStyleFile(file.path)) {
      nodes.push({
        id: `file:${file.path}`,
        type: "style_rule",
        displayName: file.path,
        sourceFile: file.path,
        sourceRange: { start: 0, end: file.content.length },
        parentId: null,
        childrenIds: [],
        depth: 0,
      });
    } else {
      nodes.push({
        id: `file:${file.path}`,
        type: "code_file",
        displayName: file.path,
        sourceFile: file.path,
        sourceRange: { start: 0, end: file.content.length },
        parentId: null,
        childrenIds: [],
        depth: 0,
      });
    }
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const childId of node.childrenIds) {
      const child = nodeMap.get(childId);
      if (child) {
        child.depth = node.depth + 1;
      }
    }
  }

  return { nodes, mappings, sourceFiles: nextFiles, warnings };
}

export function instrumentReactSource(path: string, source: string): string {
  const ast = parseReact(path, source);
  let changed = ensureSelectionBridge(ast, source);

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const existingId = getJsxAttribute(opening, "data-dev-design-id");
      const id = existingId ? getStringAttributeValue(existingId) : makeElementId(path, sourceFilename(path));

      if (!existingId) {
        opening.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-dev-design-id"), t.stringLiteral(id)));
        changed = true;
      }

      const existingClick = getJsxAttribute(opening, "onClickCapture");
      if (!existingClick || isDevDesignClickAttribute(existingClick)) {
        if (existingClick) {
          opening.attributes = opening.attributes.filter((attribute) => attribute !== existingClick);
        }
        opening.attributes.push(makeSelectionClickAttribute(id));
        changed = true;
      }
    },
  });

  return changed ? generate(ast, { retainLines: false, comments: true }, source).code : source;
}

function ensureSelectionBridge(ast: ReturnType<typeof parseReact>, source: string): boolean {
  if (source.includes("__DEV_DESIGN_OVERLAY__")) {
    return false;
  }
  const bridge = parseReact("dev-design-selection-bridge.tsx", `
/* dev-design-selection-bridge-start */
if (typeof window !== "undefined" && !Reflect.get(window, "__DEV_DESIGN_SELECTION_LISTENER__")) {
  Reflect.set(window, "__DEV_DESIGN_SELECTION_LISTENER__", true);
  Reflect.set(window, "__DEV_DESIGN_SELECTION_MODE__", false);
  Reflect.set(window, "__DEV_DESIGN_SELECTED_ELEMENT__", null);
  const getDevDesignOverlay = () => {
    let overlay = Reflect.get(window, "__DEV_DESIGN_OVERLAY__");
    if (overlay) {
      return overlay;
    }
    overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "0px",
      height: "0px",
      display: "none",
      pointerEvents: "none",
      border: "2px solid #1493ff",
      boxSizing: "border-box",
      zIndex: "2147483647"
    });
    ["nw", "ne", "sw", "se"].forEach(position => {
      const handle = document.createElement("div");
      handle.dataset.handle = position;
      Object.assign(handle.style, {
        position: "absolute",
        width: "8px",
        height: "8px",
        background: "#ffffff",
        border: "2px solid #1493ff",
        boxSizing: "border-box"
      });
      if (position.includes("n")) {
        handle.style.top = "-5px";
      } else {
        handle.style.bottom = "-5px";
      }
      if (position.includes("w")) {
        handle.style.left = "-5px";
      } else {
        handle.style.right = "-5px";
      }
      overlay.appendChild(handle);
    });
    const label = document.createElement("div");
    label.dataset.label = "size";
    Object.assign(label.style, {
      position: "absolute",
      left: "50%",
      bottom: "-28px",
      transform: "translateX(-50%)",
      padding: "3px 7px",
      borderRadius: "4px",
      background: "#1493ff",
      color: "#ffffff",
      font: "700 12px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      whiteSpace: "nowrap"
    });
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);
    Reflect.set(window, "__DEV_DESIGN_OVERLAY__", overlay);
    return overlay;
  };
  const updateDevDesignOverlay = () => {
    const overlay = Reflect.get(window, "__DEV_DESIGN_OVERLAY__");
    const selected = Reflect.get(window, "__DEV_DESIGN_SELECTED_ELEMENT__");
    if (!overlay || !selected || !Reflect.get(window, "__DEV_DESIGN_SELECTION_MODE__") || !document.documentElement.contains(selected)) {
      if (overlay) {
        overlay.style.display = "none";
      }
      return;
    }
    const rect = selected.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      overlay.style.display = "none";
      return;
    }
    Object.assign(overlay.style, {
      display: "block",
      left: \`\${rect.left}px\`,
      top: \`\${rect.top}px\`,
      width: \`\${rect.width}px\`,
      height: \`\${rect.height}px\`
    });
    const label = overlay.querySelector("[data-label='size']");
    if (label) {
      label.textContent = \`\${Math.round(rect.width)} x \${Math.round(rect.height)}\`;
    }
  };
  Reflect.set(window, "__DEV_DESIGN_OVERLAY_UPDATE__", updateDevDesignOverlay);
  Reflect.set(window, "__DEV_DESIGN_SELECT__", (event, id) => {
    if (!Reflect.get(window, "__DEV_DESIGN_SELECTION_MODE__")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    const selected = element?.closest?.("[data-dev-design-id]");
    const selectedId = selected?.getAttribute?.("data-dev-design-id") || id;
    Reflect.set(window, "__DEV_DESIGN_SELECTED_ELEMENT__", selected);
    getDevDesignOverlay();
    updateDevDesignOverlay();
    const rect = selected?.getBoundingClientRect?.();
    const style = selected ? window.getComputedStyle(selected) : null;
    window.parent.postMessage({
      type: "dev-design-select",
      id: selectedId,
      bounds: rect ? {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top
      } : null,
      style: style ? {
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        opacity: style.opacity,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow
      } : null
    }, "*");
  });
  window.addEventListener("message", event => {
    if (event.data?.type === "dev-design-selection-mode") {
      Reflect.set(window, "__DEV_DESIGN_SELECTION_MODE__", Boolean(event.data.enabled));
      if (!event.data.enabled) {
        Reflect.set(window, "__DEV_DESIGN_SELECTED_ELEMENT__", null);
      }
      getDevDesignOverlay();
      updateDevDesignOverlay();
    }
  });
  window.addEventListener("scroll", updateDevDesignOverlay, true);
  window.addEventListener("resize", updateDevDesignOverlay);
}
/* dev-design-selection-bridge-end */
`);
  ast.program.body.unshift(...bridge.program.body);
  return true;
}

function makeSelectionClickAttribute(id: string): t.JSXAttribute {
  return t.jsxAttribute(
    t.jsxIdentifier("onClickCapture"),
    t.jsxExpressionContainer(
      t.arrowFunctionExpression(
        [t.identifier("event")],
        t.blockStatement([
          t.variableDeclaration("const", [
            t.variableDeclarator(
              t.identifier("select"),
              t.callExpression(t.memberExpression(t.identifier("Reflect"), t.identifier("get")), [
                t.identifier("window"),
                t.stringLiteral("__DEV_DESIGN_SELECT__"),
              ]),
            ),
          ]),
          t.ifStatement(
            t.identifier("select"),
            t.blockStatement([
              t.expressionStatement(t.callExpression(t.identifier("select"), [t.identifier("event"), t.stringLiteral(id)])),
            ]),
          ),
          t.ifStatement(
            t.callExpression(t.memberExpression(t.identifier("Reflect"), t.identifier("get")), [
              t.identifier("window"),
              t.stringLiteral("__DEV_DESIGN_SELECTION_MODE__"),
            ]),
            t.blockStatement([
              t.variableDeclaration("const", [
                t.variableDeclarator(t.identifier("target"), t.memberExpression(t.identifier("event"), t.identifier("target"))),
              ]),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier("element"),
                  t.conditionalExpression(
                    t.binaryExpression(
                      "===",
                      t.optionalMemberExpression(t.identifier("target"), t.identifier("nodeType"), false, true),
                      t.numericLiteral(1),
                    ),
                    t.identifier("target"),
                    t.optionalMemberExpression(t.identifier("target"), t.identifier("parentElement"), false, true),
                  ),
                ),
              ]),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier("selected"),
                  t.optionalCallExpression(
                    t.optionalMemberExpression(t.identifier("element"), t.identifier("closest"), false, true),
                    [t.stringLiteral("[data-dev-design-id]")],
                    true,
                  ),
                ),
              ]),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier("selectedId"),
                  t.logicalExpression(
                    "||",
                    t.optionalCallExpression(
                      t.optionalMemberExpression(t.identifier("selected"), t.identifier("getAttribute"), false, true),
                      [t.stringLiteral("data-dev-design-id")],
                      true,
                    ),
                    t.stringLiteral(id),
                  ),
                ),
              ]),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier("rect"),
                  t.optionalCallExpression(
                    t.optionalMemberExpression(t.identifier("selected"), t.identifier("getBoundingClientRect"), false, true),
                    [],
                    true,
                  ),
                ),
              ]),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier("style"),
                  t.conditionalExpression(
                    t.identifier("selected"),
                    t.callExpression(
                      t.memberExpression(t.identifier("window"), t.identifier("getComputedStyle")),
                      [t.identifier("selected")],
                    ),
                    t.nullLiteral(),
                  ),
                ),
              ]),
              t.expressionStatement(
                t.callExpression(t.memberExpression(t.memberExpression(t.identifier("window"), t.identifier("parent")), t.identifier("postMessage")), [
                  t.objectExpression([
                    t.objectProperty(t.identifier("type"), t.stringLiteral("dev-design-select")),
                    t.objectProperty(t.identifier("id"), t.identifier("selectedId")),
                    t.objectProperty(
                      t.identifier("bounds"),
                      t.conditionalExpression(
                        t.identifier("rect"),
                        t.objectExpression([
                          t.objectProperty(t.identifier("width"), t.memberExpression(t.identifier("rect"), t.identifier("width"))),
                          t.objectProperty(t.identifier("height"), t.memberExpression(t.identifier("rect"), t.identifier("height"))),
                          t.objectProperty(t.identifier("left"), t.memberExpression(t.identifier("rect"), t.identifier("left"))),
                          t.objectProperty(t.identifier("top"), t.memberExpression(t.identifier("rect"), t.identifier("top"))),
                        ]),
                        t.nullLiteral(),
                      ),
                    ),
                    t.objectProperty(
                      t.identifier("style"),
                      t.conditionalExpression(
                        t.identifier("style"),
                        t.objectExpression([
                          t.objectProperty(t.identifier("color"), t.memberExpression(t.identifier("style"), t.identifier("color"))),
                          t.objectProperty(t.identifier("backgroundColor"), t.memberExpression(t.identifier("style"), t.identifier("backgroundColor"))),
                          t.objectProperty(t.identifier("fontSize"), t.memberExpression(t.identifier("style"), t.identifier("fontSize"))),
                          t.objectProperty(t.identifier("fontWeight"), t.memberExpression(t.identifier("style"), t.identifier("fontWeight"))),
                          t.objectProperty(t.identifier("opacity"), t.memberExpression(t.identifier("style"), t.identifier("opacity"))),
                          t.objectProperty(t.identifier("borderColor"), t.memberExpression(t.identifier("style"), t.identifier("borderColor"))),
                          t.objectProperty(t.identifier("borderWidth"), t.memberExpression(t.identifier("style"), t.identifier("borderWidth"))),
                          t.objectProperty(t.identifier("borderRadius"), t.memberExpression(t.identifier("style"), t.identifier("borderRadius"))),
                          t.objectProperty(t.identifier("boxShadow"), t.memberExpression(t.identifier("style"), t.identifier("boxShadow"))),
                        ]),
                        t.nullLiteral(),
                      ),
                    ),
                  ]),
                  t.stringLiteral("*"),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ),
  );
}

function isDevDesignClickAttribute(attribute: t.JSXAttribute): boolean {
  if (!attribute.value) {
    return false;
  }
  const code = generate(attribute.value).code;
  return code.includes("dev-design-select") || code.includes("__DEV_DESIGN_SELECT__");
}

function collectJsxElements(filePath: string, source: string): JsxElementRecord[] {
  const ast = parseReact(filePath, source);
  const records: JsxElementRecord[] = [];
  const stack: JsxElementRecord[] = [];

  traverse(ast, {
    JSXElement: {
      enter(jsxPath) {
        const start = jsxPath.node.start ?? 0;
        const end = jsxPath.node.end ?? start;
        const opening = jsxPath.node.openingElement;
        const idAttribute = getJsxAttribute(opening, "data-dev-design-id");
        const id = idAttribute ? getStringAttributeValue(idAttribute) : makeElementId(jsxPath, filePath);
        const parent = stack[stack.length - 1] ?? null;
        const record: JsxElementRecord = {
          id,
          displayName: elementLabel(opening),
          sourceFile: filePath,
          start,
          end,
          parentId: parent?.id ?? null,
          childrenIds: [],
        };
        if (parent) {
          parent.childrenIds.push(record.id);
        }
        records.push(record);
        stack.push(record);
      },
      exit() {
        stack.pop();
      },
    },
  });

  return records;
}

function parseReact(path: string, source: string) {
  return parse(source, {
    sourceType: "module",
    sourceFilename: path,
    errorRecovery: true,
    plugins: [
      "jsx",
      "typescript",
      "decorators-legacy",
      "classProperties",
      "objectRestSpread",
      "dynamicImport",
      "importMeta",
    ],
  });
}

function makeFileNode(file: SourceFile): ProjectNode {
  return {
    id: `file:${file.path}`,
    type: isPagePath(file.path) ? "page" : "component",
    displayName: file.path,
    sourceFile: file.path,
    sourceRange: { start: 0, end: file.content.length },
    parentId: null,
    childrenIds: [],
    depth: 0,
  };
}

function isPagePath(path: string): boolean {
  return (
    /(^|\/)(pages|app|routes)\//.test(path) ||
    /(^|\/)(App|main|index)\.(tsx|jsx)$/.test(path) ||
    /\/page\.(tsx|jsx)$/.test(path)
  );
}

function elementLabel(opening: t.JSXOpeningElement): string {
  const tag = jsxNameToString(opening.name);
  const classAttribute = getJsxAttribute(opening, "className");
  const className = classAttribute ? getStringAttributeValue(classAttribute) : "";
  const token = className
    .split(/\s+/)
    .filter(Boolean)
    .find((item) => !item.includes("[") && !item.includes(":"));
  return token ? `${tag}.${token}` : tag;
}

function jsxNameToString(name: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
  if (t.isJSXIdentifier(name)) {
    return name.name;
  }
  if (t.isJSXMemberExpression(name)) {
    return `${jsxNameToString(name.object)}.${jsxNameToString(name.property)}`;
  }
  if (t.isJSXNamespacedName(name)) {
    return `${name.namespace.name}:${name.name.name}`;
  }
  return "element";
}

function getJsxAttribute(opening: t.JSXOpeningElement, name: string): t.JSXAttribute | undefined {
  return opening.attributes.find(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name) && attribute.name.name === name,
  );
}

function getStringAttributeValue(attribute: t.JSXAttribute): string {
  if (t.isStringLiteral(attribute.value)) {
    return attribute.value.value;
  }
  if (
    t.isJSXExpressionContainer(attribute.value) &&
    t.isStringLiteral(attribute.value.expression)
  ) {
    return attribute.value.expression.value;
  }
  return "";
}

function makeElementId(path: NodePath<t.JSXElement>, filename: string): string {
  const start = path.node.start ?? 0;
  const end = path.node.end ?? start;
  return `dd-${hash(`${filename}:${start}:${end}`)}`;
}

function sourceFilename(path: NodePath<t.JSXElement>): string {
  const hub = path.hub as unknown as { file?: { opts?: { filename?: string } } };
  return pathToPosix(hub.file?.opts?.filename ?? "source");
}

function hash(input: string): string {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value += (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24);
  }
  return (value >>> 0).toString(36);
}

function pathToPosix(path: string): string {
  return path.replace(/\\/g, "/");
}
