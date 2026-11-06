// Chrome only: the offscreen document that plays audio and runs the player.
// Chrome closes it after ~30 s without sound, so the player's state is saved
// to storage.session (through the service worker) and restored on the next start.

import { COMMANDS, attachMediaSession, fetchJson, fetchText, htmlAudioPort, servePopupPorts } from "@/lib/host";
import { bridge } from "@/lib/hosts/chrome";
import { listen } from "@/lib/messaging";
import { Player } from "@/lib/player";
import type { PlayerCommand } from "@/lib/types";

const player = new Player({
  audio: htmlAudioPort(document.querySelector("audio")!),
  bandcampTabs: () => bridge("bandcampTabs"),
  sendToTab: (tabId, msg) => bridge("sendToTab", tabId, msg) as Promise<any>,
  fetchJson,
  fetchText,
  getCapture: (tabId) => bridge("getCapture", tabId),
  settings: {
    load: () => bridge("loadSettings"),
    save: (s) => bridge("saveSettings", s),
  },
});

const ready = bridge("loadSnapshot")
  .catch(() => null)
  .then((snap) => player.init(snap))
  .then(() => player);

servePopupPorts(ready);
attachMediaSession(player);

listen((msg) => {
  if (msg.to !== "player" || msg.type !== "command") return undefined;
  const c = msg.command as PlayerCommand;
  if (!Object.values(COMMANDS).some((k) => k.cmd === c?.cmd)) return undefined;
  return ready.then((p) => p.handle(c));
});

// Save after changes settle, so a closed document can pick up where it stopped.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
void ready.then((p) =>
  p.subscribe((e) => {
    if (e.type !== "state") return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void bridge("saveSnapshot", p.snapshot()).catch(() => {}), 500);
  }),
);
