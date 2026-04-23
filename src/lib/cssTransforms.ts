import postcss from "postcss";
import type { SourceFile, StyleUpdate } from "./types";

const CSS_PROPERTY_MAP: Record<string, string> = {
  width: "width",
  height: "height",
  margin: "margin",
  padding: "padding",
  gap: "gap",
  "font-size": "font-size",
  "font-weight": "font-weight",
  color: "color",
  "background-color": "background-color",
  border: "border",
  "border-radius": "border-radius",
  display: "display",
  "align-items": "align-items",
  "justify-content": "justify-content",
  visibility: "visibility",
};

export function applyCssRuleUpdate(
  files: SourceFile[],
  className: string,
  updates: StyleUpdate[],
): { files: SourceFile[]; changedPath: string | null; warning: string | null } {
  const escaped = escapeClassName(className);
  const candidates = files.filter((file) => /\.(module\.)?(css|scss|sass|less)$/.test(file.path));
  const target = candidates.find((file) => new RegExp(`\\.${escaped}(\\W|$)`).test(file.content));

  if (!target) {
    return {
      files,
      changedPath: null,
      warning: `No CSS rule matching .${className} was found. Use Tailwind or inline mode for this element.`,
    };
  }

  const root = postcss.parse(target.content, { from: target.path });
  let changed = false;
  root.walkRules((rule) => {
    if (!selectorContainsClass(rule.selector, className)) {
      return;
    }
    for (const update of updates) {
      const property = CSS_PROPERTY_MAP[update.property];
      if (!property || !update.value.trim()) {
        continue;
      }
      const existing = rule.nodes?.find(
        (node): node is postcss.Declaration => node.type === "decl" && node.prop === property,
      );
      if (existing) {
        existing.value = update.value.trim();
      } else {
        rule.append({ prop: property, value: update.value.trim() });
      }
      changed = true;
    }
  });

  if (!changed) {
    return {
      files,
      changedPath: null,
      warning: `The CSS parser could not safely update .${className}.`,
    };
  }

  return {
    files: files.map((file) => (file.path === target.path ? { ...file, content: root.toString() } : file)),
    changedPath: target.path,
    warning: null,
  };
}

function selectorContainsClass(selector: string, className: string): boolean {
  return selector.split(",").some((part) => new RegExp(`\\.${escapeClassName(className)}(\\W|$)`).test(part));
}

function escapeClassName(className: string): string {
  return className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
