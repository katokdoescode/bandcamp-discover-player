import { defineContentScript } from "wxt/utils/define-content-script";
import { installDiscoverHook } from "@/lib/hook";

// Chrome only. Firefox reads the same responses with webRequest.filterResponseData,
// because its MV2 build can't add a main-world script past Bandcamp's strict CSP.
export default defineContentScript({
  matches: ["*://bandcamp.com/*"],
  world: "MAIN",
  runAt: "document_start",
  include: ["chrome"],
  main() {
    installDiscoverHook(window);
  },
});
