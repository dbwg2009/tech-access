// On-screen keyboard (kiosk Chromium has none of its own). Used for a new person's name and the
// day pass company / reason.
import { h, mount } from "./dom";

const LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const NUMBERS = ["1234567890", "-/:;()&@\"", ".,?!'£+"];

export function keyboard(title: string, initial: string, maxLength: number, done: (v: string | null) => void): void {
  let value = initial;
  let shift = initial.length === 0;
  let nums = false;

  const render = () => {
    const rows = (nums ? NUMBERS : LETTERS).map((r, i) =>
      h(
        "div",
        { class: "kb-row" },
        i === 2 && !nums ? h("button", { class: `key wide${shift ? " on" : ""}`, onclick: () => ((shift = !shift), render()) }, "Shift") : null,
        [...r].map((ch) => {
          const c = shift && !nums ? ch.toUpperCase() : ch;
          return h("button", { class: "key", onclick: () => type(c) }, c);
        }),
        i === 2 ? h("button", { class: "key wide", onclick: () => ((value = value.slice(0, -1)), render()) }, "⌫ Delete") : null,
      ),
    );
    mount(
      "overlay",
      h(
        "div",
        { class: "kb-top" },
        h("div", { class: "title" }, title),
        h("div", { class: `field${value ? "" : " placeholder"}` }, value || "Type here"),
      ),
      h(
        "div",
        { class: "kb" },
        rows,
        h(
          "div",
          { class: "kb-row" },
          h("button", { class: "key wide", onclick: () => done(null) }, "Cancel"),
          h("button", { class: "key wide", onclick: () => ((nums = !nums), render()) }, nums ? "ABC" : "123"),
          h("button", { class: "key space", onclick: () => type(" ") }, "space"),
          h("button", { class: "key done", onclick: () => done(value.trim().replace(/\s+/g, " ")) }, "Done"),
        ),
      ),
    );
  };

  const type = (c: string) => {
    if (value.length >= maxLength) return;
    value += c;
    if (shift && c !== " ") shift = false;
    if (c === " " && !nums) shift = false;
    render();
  };

  render();
}
