// #/grown-ups : placeholder until the grown-ups' corner is built. It shows whether this device
// has joined a hub, and a join link (#join=<code>) works from anywhere.
import { h } from "../dom.js";
import { getHubCode } from "../app.js";

export function render(root, params = {}) {
  root.append(h("main", { class: "page narrow" },
    h("a", { class: "back", href: "#/" }, "← Back"),
    h("h1", { class: "title" }, "Grown-ups"),
    params.notice && h("p", { class: "banner", role: "alert" }, params.notice),
    h("p", { class: "lead" },
      getHubCode()
        ? "This device has joined the family hub."
        : "This device hasn’t joined a hub yet. Open the hub’s join link here to connect it."),
    h("p", { class: "muted" }, "Settings, ticket rates and the TV ladder are coming here soon.")));
}
