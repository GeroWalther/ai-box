// In-app auto-update: on desktop launch, check GitHub Releases for a newer signed
// build and install it in the background. The user restarts when convenient (or we
// offer a relaunch). No-op on the phone / web.
import { isTauri } from "./transport";

export async function checkForUpdate(
  onStatus: (msg: string, kind: "info" | "ready") => void
): Promise<void> {
  if (!isTauri()) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return;
    onStatus(`Downloading update ${update.version}…`, "info");
    await update.downloadAndInstall();
    onStatus(`Update ${update.version} installed — restart AI Box to apply.`, "ready");
  } catch {
    /* offline, no release yet, or unsigned — silently skip */
  }
}

/** Relaunch the app (used after an update is downloaded). */
export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    /* ignore */
  }
}
