/** Boot the app, then register the worker that makes it work with the network off. */

import { boot } from "./app.js";

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch(() => {
      /* no worker (http:, private mode) — the app still runs, it just is not offline */
    });
  });
}
