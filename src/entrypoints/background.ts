import { defineBackground } from "wxt/utils/define-background";
import { startChromeServiceWorker } from "@/lib/hosts/chrome";
import { startFirefoxHost } from "@/lib/hosts/firefox";

export default defineBackground({
  // Firefox MV2: a persistent page, so the player and its <audio> never get unloaded.
  persistent: true,
  main() {
    if (import.meta.env.FIREFOX) startFirefoxHost();
    else startChromeServiceWorker();
  },
});
