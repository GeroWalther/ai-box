// Thin typed wrappers over the Rust commands. Everything goes through the
// transport layer so the exact same calls work in the desktop app (Tauri IPC)
// and over the network on a phone (HTTP + WebSocket).
import { invokeCmd, streamCmd } from "./transport";
import type { ChatMsg } from "./presets";

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface GenerateArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMsg[];
  temperature: number;
  maxTokens: number;
}

export interface StreamHandlers {
  onToken: (t: string) => void;
  onReasoning?: (t: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

/** Stream a chat completion. Returns once the stream is fully consumed. Pass a
 *  `requestId` to make it cancellable via cancelStream() (server-side abort). */
export async function generateText(
  args: GenerateArgs,
  handlers: StreamHandlers,
  requestId?: string
): Promise<void> {
  await streamCmd<void>(
    "generate_text",
    {
      params: {
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        messages: args.messages,
        temperature: args.temperature,
        maxTokens: args.maxTokens,
      },
      requestId,
    },
    (msg: StreamEvent) => {
      if (msg.type === "token") handlers.onToken(msg.content);
      else if (msg.type === "reasoning") handlers.onReasoning?.(msg.content);
      else if (msg.type === "done") handlers.onDone();
      else if (msg.type === "error") handlers.onError(msg.message);
    }
  );
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  return invokeCmd<string[]>("list_ollama_models", { baseUrl });
}

export interface OpenrouterModel {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  created: number;
  outputText: boolean;
  outputImage: boolean;
  inputImage: boolean;
}

/** Fetch OpenRouter's live model catalog (newest first). Key is optional. */
export async function listOpenrouterModels(apiKey?: string): Promise<OpenrouterModel[]> {
  return invokeCmd<OpenrouterModel[]>("list_openrouter_models", { apiKey: apiKey || null });
}

export interface SystemInfo {
  ramGb: number;
  chip: string;
}
export async function systemInfo(): Promise<SystemInfo> {
  return invokeCmd<SystemInfo>("system_info");
}

/** Download a URL to a destination path (~ allowed), streaming progress. */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (line: string) => void
): Promise<void> {
  await streamCmd<void>("download_file", { url, dest }, (line: string) => onProgress(line));
}

/** Pull an Ollama model, streaming progress lines. Resolves when finished. */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (line: string) => void
): Promise<void> {
  await streamCmd<void>("pull_ollama_model", { baseUrl, model }, (line: string) =>
    onProgress(line)
  );
}

export interface ImageArgs {
  baseUrl: string;
  prompt: string;
  negativePrompt: string;
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
  samplerName: string;
}

/** Returns a base64 PNG (no data-URI prefix). Automatic1111 / Forge backend. */
export async function generateImage(args: ImageArgs): Promise<string> {
  return invokeCmd<string>("generate_image", { params: args });
}

export interface ComfyArgs {
  baseUrl: string;
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
  steps: number;
  width: number;
  height: number;
  cfgScale: number;
  samplerName: string;
  scheduler: string;
  seed: number;
}

/** Returns a base64 PNG (no data-URI prefix). ComfyUI backend. */
export async function generateImageComfy(args: ComfyArgs): Promise<string> {
  return invokeCmd<string>("generate_image_comfy", { params: args });
}

export async function listComfyCheckpoints(baseUrl: string): Promise<string[]> {
  return invokeCmd<string[]>("list_comfy_checkpoints", { baseUrl });
}

// ---- Managed local image generation (ComfyUI) ----------------------------

export interface ComfyStatus {
  installed: boolean;
  running: boolean;
  url: string;
}
/** Is the managed ComfyUI runtime installed, and is an instance answering? */
export async function comfyStatus(): Promise<ComfyStatus> {
  return invokeCmd<ComfyStatus>("comfy_status");
}

export interface ComfySetupProgress {
  stage: string; // uv | source | deps | model | done
  message: string;
  pct?: number;
}
/** Download one model into the managed install (bootstrapping the runtime on the
 *  first call), streaming stage/message/pct progress. */
export async function comfyDownloadModel(
  modelUrl: string,
  modelName: string,
  onProgress: (p: ComfySetupProgress) => void
): Promise<void> {
  await streamCmd<void>(
    "comfy_download_model",
    { modelUrl, modelName },
    (p: ComfySetupProgress) => onProgress(p)
  );
}

/** Checkpoints already downloaded into the managed install (filenames). */
export async function comfyInstalledModels(): Promise<string[]> {
  return invokeCmd<string[]>("comfy_installed_models");
}

/** Start the managed ComfyUI (reuses a running instance). Returns its URL. */
export async function comfyStart(): Promise<string> {
  return invokeCmd<string>("comfy_start");
}

/** Stop the ComfyUI we started. */
export async function comfyStop(): Promise<void> {
  return invokeCmd<void>("comfy_stop");
}

export interface Img2ImgArgs {
  baseUrl: string;
  checkpoint: string;
  prompt: string;
  negativePrompt: string;
  steps: number;
  cfgScale: number;
  samplerName: string;
  scheduler: string;
  denoise: number;
  imageBase64: string; // source image, no data-URI prefix
  seed: number;
}

/** Transform an uploaded image. Returns a base64 PNG (no prefix). */
export async function generateImg2imgComfy(args: Img2ImgArgs): Promise<string> {
  return invokeCmd<string>("generate_img2img_comfy", { params: args });
}

export interface OpenrouterImageArgs {
  apiKey: string;
  model: string;
  prompt: string;
  resolution: string;
  aspectRatio: string;
}

/** Cloud image via OpenRouter. Returns base64 (no prefix). */
export async function generateImageOpenrouter(args: OpenrouterImageArgs): Promise<string> {
  return invokeCmd<string>("generate_image_openrouter", { params: args });
}

export interface OpenrouterEditArgs {
  apiKey: string;
  model: string;
  prompt: string;
  imageBase64: string; // source image, no data-URI prefix
}

/** Edit/transform an uploaded image via OpenRouter. Returns base64 (no prefix). */
export async function editImageOpenrouter(args: OpenrouterEditArgs): Promise<string> {
  return invokeCmd<string>("edit_image_openrouter", { params: args });
}
