// Tiny DOM helper: h("div", {class: "x", onclick}, "text", child). No framework.
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; onclick?: (e: MouseEvent) => void };

export function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "onclick") el.addEventListener("click", v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function btn(label: Child, onclick: () => void, cls = "", disabled = false): HTMLElement {
  return h("button", { class: `btn ${cls}`, onclick: () => onclick(), disabled }, label);
}

export function mount(id: string, ...children: Child[]): void {
  const el = document.getElementById(id)!;
  el.replaceChildren();
  append(el, children);
}
