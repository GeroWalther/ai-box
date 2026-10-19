// The Video tab's backend (motion.rs): motion-graphics videos made on the Mac
// from a form — brief, models, voice, format, length and the person's images.
import { invokeCmd } from "./transport";

export interface MotionAsset {
  file: string;
  /** icon | screenshot | user | ai */
  kind: string;
  width: number;
  height: number;
  note: string;
}

export interface MotionStep {
  at: number;
  title: string;
  ok?: boolean | null;
  detail?: string;
}

export interface MotionProject {
  id: string;
  /** draft | script | running | done | failed | stopped */
  status: string;
  updated: number;
  rev: number;
  brief: {
    product: string;
    kind: string;
    format: string;
    seconds: number;
    language: string;
    appStore: string;
    website: string;
  };
  title: string;
  script: string;
  voiceId: string;
  voiceName: string;
  voiceSource: string;
  speechModel: string;
  imageModel: string;
  assets: MotionAsset[];
  steps: MotionStep[];
  cost: number;
  versions: number;
  videoId?: string;
  error?: string;
}

export interface MotionSummary {
  id: string;
  title: string;
  status: string;
  updated: number;
  versions: number;
  videoId?: string;
}

/** What the form holds; empty fields leave the project as it is. */
export interface MotionForm {
  brief: string;
  kind: string;
  format: string;
  seconds: number;
  language: string;
  title: string;
  script: string;
  voiceSource: string;
  speechModel: string;
  voice: string;
  voiceName: string;
  imageModel: string;
  baseUrl: string;
  model: string;
}

export interface MotionOptions {
  imageModels: { id: string; name: string }[];
  speechModels: { id: string; name: string; voices: string[] }[];
  elevenVoices: { id: string; name: string; tags: string; previewUrl?: string }[] | null;
  elevenError: string | null;
  error: string | null;
}

export const motionOptions = () => invokeCmd<MotionOptions>("motion_options");
export const motionList = () => invokeCmd<MotionSummary[]>("motion_list");
export const motionGet = (id: string, since?: number) =>
  invokeCmd<MotionProject | null>("motion_get", { id, since: since ?? null });
export const motionNew = (baseUrl: string, model: string) =>
  invokeCmd<MotionProject>("motion_new", { baseUrl, model });
export const motionSave = (id: string, form: MotionForm) => invokeCmd<MotionProject>("motion_save", { id, form });
export const motionAddAsset = (id: string, attachment: string, name: string) =>
  invokeCmd<MotionProject>("motion_add_asset", { id, attachment, name });
export const motionRemoveAsset = (id: string, file: string) =>
  invokeCmd<MotionProject>("motion_remove_asset", { id, file });
export const motionAsset = (id: string, file: string) => invokeCmd<string>("motion_asset", { id, file });
export const motionScript = (id: string, form: MotionForm) => invokeCmd<MotionProject>("motion_script", { id, form });
export const motionMake = (id: string, form: MotionForm) => invokeCmd<MotionProject>("motion_make", { id, form });
export const motionRevise = (id: string, feedback: string, redo: string) =>
  invokeCmd<void>("motion_revise", { id, feedback, redo });
export const motionSample = (id: string, source: string, model: string, voice: string, text: string) =>
  invokeCmd<string>("motion_sample", { id, source, model, voice, text });
export const motionStop = (id: string) => invokeCmd<void>("motion_stop", { id });
export const motionDelete = (id: string) => invokeCmd<void>("motion_delete", { id });
