// Motion graphics videos (src-tauri/src/motion.rs). The job runs on the Mac;
// this side starts it and watches it — the same from a paired phone.
import { invokeCmd } from "./transport";

export interface MotionBrief {
  kind: "ad" | "explainer";
  product: string;
  audience: string;
  message: string;
  tone: string;
  notes: string;
  appStore: string;
  website: string;
  format: "9:16" | "16:9" | "1:1";
  seconds: number;
  language: string;
}

export interface MotionStep {
  at: number;
  title: string;
  ok: boolean | null;
  detail?: string;
}

export interface MotionAsset {
  file: string;
  kind: "icon" | "screenshot" | "user" | "ai";
  width: number;
  height: number;
  note: string;
}

export interface MotionProject {
  id: string;
  status: "researching" | "script" | "running" | "done" | "failed" | "stopped";
  created: number;
  updated: number;
  rev: number;
  brief: MotionBrief;
  research: string;
  title: string;
  script: string;
  voiceId: string;
  voiceName: string;
  imageModel: string;
  assets: MotionAsset[];
  steps: MotionStep[];
  cost: number;
  voiceChars: number;
  videoId?: string;
  error?: string;
}

export interface MotionVoice {
  id: string;
  name: string;
  description: string | null;
  tags: string;
  previewUrl: string | null;
  category: string;
}

export interface MotionImageModel {
  id: string;
  name: string;
}

export const motionVoices = () => invokeCmd<MotionVoice[]>("motion_voices");
export const motionImageModels = () => invokeCmd<MotionImageModel[]>("motion_image_models");

export const motionScript = (params: {
  brief: MotionBrief;
  images: { name: string; base64: string }[];
  baseUrl: string;
  model: string;
}) => invokeCmd<MotionProject>("motion_script", { params });

export const motionMake = (params: {
  id: string;
  title: string;
  script: string;
  voiceId: string;
  voiceName: string;
  imageModel: string;
}) => invokeCmd<void>("motion_make", { params });

/** The project, or null when nothing changed since `since`. */
export const motionGet = (id: string, since?: number) =>
  invokeCmd<MotionProject | null>("motion_get", { id, since });

export const motionList = () =>
  invokeCmd<{ id: string; title: string; status: MotionProject["status"]; created: number }[]>(
    "motion_list"
  );

export const motionStop = (id: string) => invokeCmd<void>("motion_stop", { id });

export const isWorking = (p: MotionProject | null) =>
  !!p && (p.status === "running" || p.status === "researching");

/** Spoken length of a script, roughly: the same pace the script writer aims at. */
export function spokenSeconds(script: string, language: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  const rate = language.toLowerCase().startsWith("en") ? 2.5 : 2.2;
  return words / rate;
}
