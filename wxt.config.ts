import { defineConfig } from "wxt";

// Chrome builds as MV3 (player in an offscreen document), Firefox as MV2
// (player in a persistent background page, discover results read via webRequest).
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/auto-icons"],
  autoIcons: {
    baseIconPath: "assets/icon.svg",
  },
  manifest: ({ browser }) => ({
    name: "Discover Player for Bandcamp",
    description: "Play every track (or whole releases) from a Bandcamp discover page, in order or shuffled.",
    permissions: [
      "tabs",
      "storage",
      ...(browser === "firefox" ? ["webRequest", "webRequestBlocking"] : ["offscreen"]),
    ],
    host_permissions: ["*://*.bandcamp.com/*", "*://*.bcbits.com/*"],
    action: {
      default_title: "Discover Player",
    },
    commands: {
      "play-pause": { suggested_key: { default: "MediaPlayPause" }, description: "Play / pause" },
      "next-track": { suggested_key: { default: "MediaNextTrack" }, description: "Next track" },
      "prev-track": { suggested_key: { default: "MediaPrevTrack" }, description: "Previous track" },
    },
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "discover-player@bandcamp-streaming-plugin",
          // 140 (ESR) is the first version that knows data_collection_permissions.
          strict_min_version: "140.0",
          data_collection_permissions: { required: ["none"] },
        },
        gecko_android: { strict_min_version: "142.0" },
      },
    }),
  }),
});
