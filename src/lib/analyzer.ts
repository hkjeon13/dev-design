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
  let changed = false;

  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const existingId = getJsxAttribute(opening, "data-dev-design-id");
      const id = existingId ? getStringAttributeValue(existingId) : makeElementId(path, sourceFilename(path));

      if (!existingId) {
        opening.attributes.push(t.jsxAttribute(t.jsxIdentifier("data-dev-design-id"), t.stringLiteral(id)));
        changed = true;
      }

      if (!getJsxAttribute(opening, "onClickCapture")) {
        opening.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("onClickCapture"),
            t.jsxExpressionContainer(
              t.arrowFunctionExpression(
                [t.identifier("event")],
                t.callExpression(
                  t.memberExpression(
                    t.memberExpression(t.identifier("window"), t.identifier("parent")),
                    t.identifier("postMessage"),
                  ),
                  [
                    t.objectExpression([
                      t.objectProperty(t.identifier("type"), t.stringLiteral("dev-design-select")),
                      t.objectProperty(t.identifier("id"), t.stringLiteral(id)),
                    ]),
                    t.stringLiteral("*"),
                  ],
                ),
              ),
            ),
          ),
        );
        changed = true;
      }
    },
  });

  return changed ? generate(ast, { retainLines: false, comments: true }, source).code : source;
}

function collectJsxElements(filePath: string, source: string): JsxElementRecord[] {
  const ast = parseReact(filePath, source);
  const records: JsxElementRecord[] = [];

  traverse(ast, {
    JSXElement(jsxPath) {
      const start = jsxPath.node.start ?? 0;
      const end = jsxPath.node.end ?? start;
      const opening = jsxPath.node.openingElement;
      const idAttribute = getJsxAttribute(opening, "data-dev-design-id");
      const id = idAttribute ? getStringAttributeValue(idAttribute) : makeElementId(jsxPath, filePath);
      records.push({
        id,
        displayName: elementLabel(opening),
        sourceFile: filePath,
        start,
        end,
        parentId: null,
        childrenIds: [],
      });
    },
  });

  for (const record of records) {
    record.sourceFile = filePath;
    const parent = records
      .filter((candidate) => candidate.id !== record.id)
      .filter((candidate) => candidate.start <= record.start && candidate.end >= record.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (parent) {
      record.parentId = parent.id;
      parent.childrenIds.push(record.id);
    }
  }

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
