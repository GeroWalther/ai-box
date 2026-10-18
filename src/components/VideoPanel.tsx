// The Video tab: motion-graphics videos, made on this Mac (MotionPanel /
// motion.rs), and the library of finished ones.
//
// Three columns, one job each: the library on the left (it lives on the Mac,
// so a paired phone sees the same set), the steps in the middle (brief →
// script & voice → video), the player on the right.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { saveVideo } from "../lib/api";
import {
  allVideos,
  deleteVideo,
  getVideo,
  revokeVideoUrl,
  videoObjectUrl,
  type VideoRecord,
} from "../lib/videoStore";
import { isTauri } from "../lib/transport";
import { logError } from "../lib/log";
import { useToast } from "../lib/toast";
import { SidebarSlot } from "./SidebarList";
import MotionPanel from "./MotionPanel";
import { registerSyncSource } from "../lib/syncBus";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  /** A scene or product line handed over from Write / Images. */
  prefill?: string | null;
  onPrefillConsumed?: () => void;
  sidebarSlot: HTMLElement | null;
  onCloseDrawer?: () => void;
}

export default function VideoPanel({
  settings,
  onChange,
  prefill,
  onPrefillConsumed,
  sidebarSlot,
  onCloseDrawer,
}: Props) {
  const { success: toastOk, error: toastError } = useToast();
  const [library, setLibrary] = useState<VideoRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  // Bumped by "New video": remounts the steps on an empty brief.
  const [session, setSession] = useState(0);
  const [topic, setTopic] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Something sent over from Write or Images: start a new video about it.
  useEffect(() => {
    if (prefill?.trim()) {
      setTopic(prefill.trim().slice(0, 500));
      setSession((n) => n + 1);
      onPrefillConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const loadLibrary = useCallback(async (selectNewest: boolean) => {
    const rows = await allVideos().catch(() => [] as VideoRecord[]);
    if (!alive.current) return rows;
    setLibrary(rows);
    if (selectNewest) {
      const playable = rows.find((r) => r.status === "completed");
      if (playable) void openClip(playable.id);
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadLibrary(true);
  }, [loadLibrary]);

  useEffect(
    () => registerSyncSource("videos", () => loadLibrary(false).then(() => undefined)),
    [loadLibrary]
  );

  // Free the Blob when the selection changes or the tab unmounts — these are
  // tens of megabytes each.
  useEffect(() => () => revokeVideoUrl(playUrl), [playUrl]);

  async function openClip(id: string) {
    setActiveId(id);
    const rec = await getVideo(id).catch(() => null);
    if (!rec || rec.status !== "completed") {
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return null;
      });
      return;
    }
    try {
      const url = await videoObjectUrl(id);
      if (!alive.current) {
        revokeVideoUrl(url);
        return;
      }
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return url;
      });
    } catch (e) {
      logError("video.open", e);
      toastError("That video's file is missing.");
    }
  }

  const active = library.find((r) => r.id === activeId) ?? null;

  async function save() {
    if (!active) return;
    try {
      const path = await saveVideo(active.id, active.prompt.slice(0, 40));
      toastOk(`Saved to ${path}`);
    } catch (e) {
      toastError(String(e));
    }
  }

  async function remove(id: string) {
    await deleteVideo(id).catch(() => {});
    setLibrary((rows) => rows.filter((r) => r.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setPlayUrl((old) => {
        revokeVideoUrl(old);
        return null;
      });
    }
  }

  return (
    <div className="video-tab">
      <SidebarSlot slot={sidebarSlot}>
        <button
          className="sidebar-new"
          onClick={() => {
            setTopic(null);
            setSession((n) => n + 1);
            onCloseDrawer?.();
          }}
        >
          + New video
        </button>
        <div className="video-library">
          {library.length === 0 && (
            <div className="image-history-empty">Your videos appear here.</div>
          )}
          {library.map((r) => (
            <div
              key={r.id}
              className={activeId === r.id ? "video-item active" : "video-item"}
              title={r.prompt}
              onClick={() => {
                void openClip(r.id);
                onCloseDrawer?.();
              }}
            >
              <div className="video-item-top">
                <span className={`video-dot ${r.status}`} aria-hidden="true" />
                <span className="video-item-title">{r.prompt.slice(0, 60) || "Untitled"}</span>
                <button
                  className="history-del"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(r.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="video-item-meta">
                {r.duration ? `${r.duration}s` : ""}
                {r.aspect ? ` · ${r.aspect}` : ""}
                {r.status === "failed" ? " · failed" : ""}
              </div>
            </div>
          ))}
        </div>
      </SidebarSlot>

      <div className="image-controls-col">
        <MotionPanel
          key={session}
          resume={session === 0}
          topic={topic}
          settings={settings}
          onChange={onChange}
          onFinished={(id) => void loadLibrary(false).then(() => openClip(id))}
        />
      </div>

      <div className="image-preview-col">
        {playUrl && active ? (
          <>
            <video className="video-player" src={playUrl} controls autoPlay loop playsInline />
            <div className="preview-actions">
              <button className="btn" onClick={() => void save()}>
                {isTauri() ? "Save MP4" : "Save to Mac"}
              </button>
              <button className="btn danger" onClick={() => void remove(active.id)}>
                Delete
              </button>
            </div>
            <p className="hint">
              {active.prompt}
              {active.duration ? ` · ${active.duration}s` : ""}
              {active.resolution ? ` · ${active.resolution}` : ""}
              {active.bytes ? ` · ${(active.bytes / 1e6).toFixed(1)} MB` : ""}
              {typeof active.cost === "number" && active.cost > 0
                ? ` · $${active.cost.toFixed(2)}`
                : ""}
            </p>
          </>
        ) : (
          <div className="image-placeholder">
            Your video appears here.
            <br />
            <span className="muted">
              Describe it, approve the script, and AI Box voices, scores, animates and renders
              it on this Mac — usually a few minutes and a few cents.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
