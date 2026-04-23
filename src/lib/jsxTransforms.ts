import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { StructureOperation, StyleUpdate } from "./types";

export function applyTailwindUpdate(source: string, targetId: string, updates: StyleUpdate[]): string {
  return transformTargetElement(source, targetId, (path) => {
    const opening = path.node.openingElement;
    const classAttribute = ensureClassNameAttribute(opening);
    const existing = getStaticAttributeValue(classAttribute);
    const next = updates.reduce((tokens, update) => updateTailwindTokens(tokens, update), tokenize(existing));
    setStringAttributeValue(classAttribute, Array.from(new Set(next)).join(" "));
  });
}

export function applyInlineStyleUpdate(source: string, targetId: string, updates: StyleUpdate[]): string {
  return transformTargetElement(source, targetId, (path) => {
    const opening = path.node.openingElement;
    const styleAttribute = ensureStyleAttribute(opening);
    const expression = styleAttribute.value;
    if (!t.isJSXExpressionContainer(expression) || !t.isObjectExpression(expression.expression)) {
      return;
    }
    for (const update of updates) {
      upsertObjectProperty(expression.expression, toCamelCase(update.property), update.value);
    }
  });
}

export function applyStructureOperation(
  source: string,
  targetId: string,
  operation: StructureOperation,
  payload: Record<string, string> = {},
): string {
  const ast = parseReact(source);
  let changed = false;

  traverse(ast, {
    JSXElement(path) {
      if (changed || getElementId(path.node) !== targetId) {
        return;
      }

      if (operation === "duplicate") {
        path.insertAfter(t.cloneNode(path.node, true));
        changed = true;
      }

      if (operation === "delete") {
        path.remove();
        changed = true;
      }

      if (operation === "wrap") {
        const wrapperId = `dd-wrap-${Date.now().toString(36)}`;
        const className = payload.className || "dev-design-wrapper";
        path.replaceWith(
          t.jsxElement(
            t.jsxOpeningElement(t.jsxIdentifier("div"), [
              t.jsxAttribute(t.jsxIdentifier("data-dev-design-id"), t.stringLiteral(wrapperId)),
              t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(className)),
            ]),
            t.jsxClosingElement(t.jsxIdentifier("div")),
            [t.cloneNode(path.node, true)],
          ),
        );
        changed = true;
      }

      if (operation === "unwrap") {
        const children = path.node.children.filter((child) => !isBlankJsxText(child));
        if (children.length > 0) {
          path.replaceWithMultiple(children as unknown as t.Statement[]);
          changed = true;
        }
      }

      if (operation === "insert_child") {
        const childId = `dd-insert-${Date.now().toString(36)}`;
        const tagName = payload.tagName || "div";
        const text = payload.text || "New element";
        path.node.children.push(
          t.jsxElement(
            t.jsxOpeningElement(t.jsxIdentifier(tagName), [
              t.jsxAttribute(t.jsxIdentifier("data-dev-design-id"), t.stringLiteral(childId)),
              t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(payload.className || "p-4")),
            ]),
            t.jsxClosingElement(t.jsxIdentifier(tagName)),
            [t.jsxText(text)],
          ),
        );
        changed = true;
      }

      if (operation === "move_up" || operation === "move_down") {
        changed = moveElementAmongSiblings(path, operation);
      }
    },
  });

  return changed ? generate(ast, { comments: true }).code : source;
}

export function getClassTarget(source: string, targetId: string): string | null {
  let result: string | null = null;
  const ast = parseReact(source);
  traverse(ast, {
    JSXElement(path) {
      if (result || getElementId(path.node) !== targetId) {
        return;
      }
      const classAttribute = path.node.openingElement.attributes.find(
        (attribute): attribute is t.JSXAttribute =>
          t.isJSXAttribute(attribute) &&
          t.isJSXIdentifier(attribute.name) &&
          attribute.name.name === "className",
      );
      if (!classAttribute) {
        return;
      }
      const staticValue = getStaticAttributeValue(classAttribute);
      const plainClass = tokenize(staticValue).find((token) => /^[A-Za-z_-][\w-]*$/.test(token));
      if (plainClass) {
        result = plainClass;
        return;
      }
      if (
        t.isJSXExpressionContainer(classAttribute.value) &&
        t.isMemberExpression(classAttribute.value.expression) &&
        t.isIdentifier(classAttribute.value.expression.property)
      ) {
        result = classAttribute.value.expression.property.name;
      }
    },
  });
  return result;
}

function transformTargetElement(
  source: string,
  targetId: string,
  transform: (path: NodePath<t.JSXElement>) => void,
): string {
  const ast = parseReact(source);
  let changed = false;
  traverse(ast, {
    JSXElement(path) {
      if (changed || getElementId(path.node) !== targetId) {
        return;
      }
      transform(path);
      changed = true;
    },
  });
  return changed ? generate(ast, { comments: true }).code : source;
}

function parseReact(source: string) {
  return parse(source, {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy", "classProperties", "objectRestSpread"],
  });
}

function getElementId(element: t.JSXElement): string | null {
  const idAttribute = element.openingElement.attributes.find(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) &&
      t.isJSXIdentifier(attribute.name) &&
      attribute.name.name === "data-dev-design-id",
  );
  if (!idAttribute) {
    return null;
  }
  if (t.isStringLiteral(idAttribute.value)) {
    return idAttribute.value.value;
  }
  if (t.isJSXExpressionContainer(idAttribute.value) && t.isStringLiteral(idAttribute.value.expression)) {
    return idAttribute.value.expression.value;
  }
  return null;
}

function ensureClassNameAttribute(opening: t.JSXOpeningElement): t.JSXAttribute {
  const existing = opening.attributes.find(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) &&
      t.isJSXIdentifier(attribute.name) &&
      attribute.name.name === "className",
  );
  if (existing) {
    return existing;
  }
  const created = t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(""));
  opening.attributes.push(created);
  return created;
}

function ensureStyleAttribute(opening: t.JSXOpeningElement): t.JSXAttribute {
  const existing = opening.attributes.find(
    (attribute): attribute is t.JSXAttribute =>
      t.isJSXAttribute(attribute) &&
      t.isJSXIdentifier(attribute.name) &&
      attribute.name.name === "style",
  );
  if (existing) {
    if (!t.isJSXExpressionContainer(existing.value) || !t.isObjectExpression(existing.value.expression)) {
      existing.value = t.jsxExpressionContainer(t.objectExpression([]));
    }
    return existing;
  }
  const created = t.jsxAttribute(t.jsxIdentifier("style"), t.jsxExpressionContainer(t.objectExpression([])));
  opening.attributes.push(created);
  return created;
}

function getStaticAttributeValue(attribute: t.JSXAttribute): string {
  if (t.isStringLiteral(attribute.value)) {
    return attribute.value.value;
  }
  if (t.isJSXExpressionContainer(attribute.value) && t.isStringLiteral(attribute.value.expression)) {
    return attribute.value.expression.value;
  }
  return "";
}

function setStringAttributeValue(attribute: t.JSXAttribute, value: string) {
  attribute.value = t.stringLiteral(value);
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function updateTailwindTokens(tokens: string[], update: StyleUpdate): string[] {
  const className = tailwindClassFor(update);
  if (!className) {
    return tokens;
  }
  const group = tailwindGroup(update.property);
  const filtered = tokens.filter((token) => !group.some((matcher) => matcher.test(token)));
  return [...filtered, className];
}

function tailwindClassFor(update: StyleUpdate): string | null {
  const value = update.value.trim();
  if (!value) {
    return null;
  }
  const bracket = value.includes("[") ? value : `[${value}]`;
  switch (update.property) {
    case "width":
      return `w-${bracket}`;
    case "height":
      return `h-${bracket}`;
    case "margin":
      return `m-${bracket}`;
    case "padding":
      return `p-${bracket}`;
    case "gap":
      return `gap-${bracket}`;
    case "font-size":
      return `text-${bracket}`;
    case "font-weight":
      return value === "700" || value === "bold" ? "font-bold" : `font-[${value}]`;
    case "color":
      return `text-${bracket}`;
    case "background-color":
      return `bg-${bracket}`;
    case "border-radius":
      return `rounded-${bracket}`;
    case "display":
      return value;
    case "align-items":
      return value.startsWith("items-") ? value : `items-${value}`;
    case "justify-content":
      return value.startsWith("justify-") ? value : `justify-${value}`;
    case "visibility":
      return value === "hidden" ? "invisible" : "visible";
    default:
      return null;
  }
}

function tailwindGroup(property: string): RegExp[] {
  const groups: Record<string, RegExp[]> = {
    width: [/^w-/],
    height: [/^h-/],
    margin: [/^m[trblxy]?-/],
    padding: [/^p[trblxy]?-/],
    gap: [/^gap[xy]?-/],
    "font-size": [/^text-(xs|sm|base|lg|xl|\d|\[)/],
    "font-weight": [/^font-/],
    color: [/^text-\[/],
    "background-color": [/^bg-/],
    "border-radius": [/^rounded/],
    display: [/^(block|inline|inline-block|flex|grid|hidden)$/],
    "align-items": [/^items-/],
    "justify-content": [/^justify-/],
    visibility: [/^(visible|invisible)$/],
  };
  return groups[property] ?? [];
}

function upsertObjectProperty(object: t.ObjectExpression, key: string, value: string) {
  const existing = object.properties.find(
    (property): property is t.ObjectProperty =>
      t.isObjectProperty(property) &&
      ((t.isIdentifier(property.key) && property.key.name === key) ||
        (t.isStringLiteral(property.key) && property.key.value === key)),
  );
  if (existing) {
    existing.value = t.stringLiteral(value);
    return;
  }
  object.properties.push(t.objectProperty(t.identifier(key), t.stringLiteral(value)));
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

function moveElementAmongSiblings(path: NodePath<t.JSXElement>, operation: "move_up" | "move_down"): boolean {
  const parent = path.parentPath;
  if (!parent || !t.isJSXElement(parent.node)) {
    return false;
  }
  const children = parent.node.children;
  const index = children.indexOf(path.node);
  if (index < 0) {
    return false;
  }
  const targetIndex = operation === "move_up" ? previousElementIndex(children, index) : nextElementIndex(children, index);
  if (targetIndex < 0) {
    return false;
  }
  const [node] = children.splice(index, 1);
  children.splice(targetIndex, 0, node);
  return true;
}

function previousElementIndex(children: t.JSXElement["children"], from: number): number {
  for (let index = from - 1; index >= 0; index -= 1) {
    if (t.isJSXElement(children[index])) {
      return index;
    }
  }
  return -1;
}

function nextElementIndex(children: t.JSXElement["children"], from: number): number {
  for (let index = from + 1; index < children.length; index += 1) {
    if (t.isJSXElement(children[index])) {
      return index;
    }
  }
  return -1;
}

function isBlankJsxText(node: t.JSXElement["children"][number]): boolean {
  return t.isJSXText(node) && node.value.trim() === "";
}
