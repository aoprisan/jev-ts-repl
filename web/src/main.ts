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
    /*
     * A worker that precaches the whole shell will happily serve yesterday's app forever, which is
     * what "offline" costs if nobody arranges the handover. Two things arrange it: the worker
     * script is read from the network rather than the HTTP cache, so a deploy is noticed on the
     * next visit rather than ten minutes later; and the page steps aside once the new worker has
     * taken over, which it does immediately — it claims its clients as soon as it activates.
     *
     * Only a page that was already being served by an older worker reloads. A first visit has no
     * worker to replace, and the reload happens once per deploy: the page's text and settings are
     * in storage, not in the DOM, so it comes back as it was.
     */
    const controlled = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (controlled) window.location.reload();
    });

    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {
        /* no worker (http:, private mode) — the app still runs, it just is not offline */
      });
    });
  }
}
