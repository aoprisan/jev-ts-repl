/** Boot the app, then register the worker that makes it work with the network off. */

import { boot } from "./app.js";

/**
 * The frame guard, again. The inline copy in the head runs before the first paint; this one is the
 * one that actually decides, so the app stays unbuilt even if that script never ran.
 */
if (window.top !== window.self) {
  document.documentElement.setAttribute("data-framed", "");
} else {
  boot();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("./sw.js").catch(() => {
        /* no worker (http:, private mode) — the app still runs, it just is not offline */
      });
    });
  }
}
