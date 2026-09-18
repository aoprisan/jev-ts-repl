/** The smallest DOM helpers the app needs, plus the bridge from the REPL's styled lines. */

import type { Line, Span } from "jev-repl/core";

type Props = Record<string, string | number | boolean | EventListener | undefined>;

/** `h("button", { class: "ghost", onclick: fn }, ["Copy"])`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith("on") && typeof value === "function") {
      el.addEventListener(name.slice(2), value as EventListener);
    } else if (value === true) {
      el.setAttribute(name, "");
    } else {
      el.setAttribute(name, String(value));
    }
  }
  el.append(...children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** One styled span, as the terminal would have drawn it. */
function spanNode(s: Span): HTMLElement {
  const el = document.createElement("span");
  el.textContent = s.text;
  const classes: string[] = [];
  if (s.style.fg && s.style.fg !== "reset") classes.push(`c-${s.style.fg}`);
  if (s.style.bold) classes.push("bold");
  if (s.style.reverse) classes.push("reverse");
  if (classes.length > 0) el.className = classes.join(" ");
  return el;
}

/** Styled lines — answers, highlighted notation — as a block of DOM. */
export function lines(source: readonly Line[]): DocumentFragment {
  const out = document.createDocumentFragment();
  for (const l of source) {
    const row = document.createElement("div");
    row.className = "line";
    for (const s of l.spans) row.append(spanNode(s));
    if (l.spans.length === 0) row.append(document.createTextNode(" "));
    out.append(row);
  }
  return out;
}
