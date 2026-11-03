// Hash router: #/ (picker), #/kid/<id>, #/grown-ups, #join=<hub code>.
import { isHubCode } from "./hub-client.js";
import { joinHub } from "./app.js";
import * as pick from "./screens/pick.js";
import * as kid from "./screens/kid.js";
import * as grownups from "./screens/grownups.js";

const root = document.getElementById("app");
let cleanup = null;

function show(screen, params) {
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  root.replaceChildren();
  cleanup = screen.render(root, params) || null;
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash;
  if (hash.startsWith("#join=")) {
    let code = "";
    try { code = decodeURIComponent(hash.slice(6)); } catch { /* bad escape: treated as not a code */ }
    const joined = isHubCode(code) && joinHub(code);
    // Replace the URL so the code doesn't stay in the address bar or the history.
    history.replaceState(null, "", location.pathname + location.search + (joined ? "#/" : "#/grown-ups"));
    return show(joined ? pick : grownups, joined ? {} : { notice: "That join link isn't a valid hub code." });
  }
  const m = /^#\/kid\/([\w-]+)$/.exec(hash);
  if (m) return show(kid, { id: m[1] });
  if (hash === "#/grown-ups") return show(grownups, {});
  show(pick, {});
}

addEventListener("hashchange", route);
route();
