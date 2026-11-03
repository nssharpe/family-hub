// #/ : who is here? One big button per kid in the hub settings (defaults without a hub).
import { h } from "../dom.js";
import { getHubCode, getSettings, refreshSettings } from "../app.js";

export function render(root) {
  const list = h("ul", { class: "kid-list" });
  const hasHub = !!getHubCode();

  const fill = () => {
    const kids = Object.entries(getSettings().kids);
    list.replaceChildren(...kids.map(([id, k]) => h("li", {},
      h("a", { class: "kid-btn", href: `#/kid/${encodeURIComponent(id)}` },
        h("span", { class: "avatar", "aria-hidden": "true" }, Array.from(k.name)[0] || "?"),
        h("span", { class: "kid-name" }, k.name)))));
  };
  fill();

  root.append(h("main", { class: "page narrow" },
    h("h1", { class: "title" }, "Family Hub"),
    h("p", { class: "lead" }, "Who’s here? Pick your name to see your TV time."),
    list,
    hasHub
      ? h("p", { class: "foot" }, h("a", { class: "text-link", href: "#/grown-ups" }, "Grown-ups"))
      : h("div", { class: "callout" },
          h("p", {}, "Only AMC tickets show until the hub is set up on this device."),
          h("a", { class: "btn secondary", href: "#/grown-ups" }, "Grown-ups: set up the hub"))));

  let live = true;
  if (hasHub) refreshSettings().then(changed => { if (live && changed) fill(); });
  return () => { live = false; };
}
