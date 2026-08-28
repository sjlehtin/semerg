import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const dataFile = fileURLToPath(new URL("./public/data.json", import.meta.url));

/**
 * Reload the page's data when public/data.json changes.
 *
 * Vite serves publicDir as plain static files and does not watch it, so a
 * `semerg gather-data --output front/public/data.json` -- or an edit to the
 * fixture -- otherwise shows up only when the page's own five-minute poll comes
 * round. Source edits are already covered by HMR.
 *
 * Sends a plain reload rather than a custom event, so that nothing has to
 * listen for it: a custom event would need an `import.meta.hot` block in
 * main.js, and dev tooling does not belong in application code even when the
 * build strips it out again. The cost is that a reload discards the highlighted
 * task and the scroll position, which is a fair trade in development.
 */
function watchDataFile() {
  return {
    name: "semerg:watch-data",
    apply: "serve",

    configureServer(server) {
      server.watcher.add(dataFile);

      let pending;
      const notify = (changed) => {
        if (resolve(changed) !== dataFile) return;
        // gather-data truncates the file the moment it opens it, so a watcher
        // firing on the first write would fetch a half-written document.
        // Settle briefly instead.
        clearTimeout(pending);
        pending = setTimeout(() => {
          (server.hot ?? server.ws).send({ type: "full-reload" });
        }, 200);
      };

      server.watcher.on("add", notify);
      server.watcher.on("change", notify);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), watchDataFile()],
  build: {
    // Hashed assets land in dist/assets/ and are uploaded with a long,
    // immutable cache lifetime; everything else gets a short TTL. See
    // docs/deployment.md.
    assetsDir: "assets",
    sourcemap: true,
  },
  test: {
    environment: "node",
    // Tariff boundaries are Finnish. Without pinning this, tests asserting the
    // 07:00/22:00 transfer-fee step pass on a Helsinki laptop and fail on a UTC
    // runner.
    env: { TZ: "UTC" },
  },
});
