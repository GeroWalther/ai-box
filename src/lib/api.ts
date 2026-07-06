// Thin typed wrappers over the Rust commands.
import { invoke, Channel } from "@tauri-apps/api/core";
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

/** Stream a chat completion. Returns once the stream is fully consumed. */
export async function generateText(
  args: GenerateArgs,
  handlers: StreamHandlers
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = (msg) => {
    if (msg.type === "token") handlers.onToken(msg.content);
    else if (msg.type === "reasoning") handlers.onReasoning?.(msg.content);
    else if (msg.type === "done") handlers.onDone();
    else if (msg.type === "error") handlers.onError(msg.message);
  };

  await invoke("generate_text", {
    params: {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
    },
    onEvent: channel,
  });
}

export async function listOllamaModels(baseUrl: string): Promise<string[]> {
  return invoke<string[]>("list_ollama_models", { baseUrl });
}

export interface OpenrouterModel {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
  created: number;
}

/** Fetch OpenRouter's live model catalog (newest first). Key is optional. */
export async function listOpenrouterModels(apiKey?: string): Promise<OpenrouterModel[]> {
  return invoke<OpenrouterModel[]>("list_openrouter_models", { apiKey: apiKey || null });
}

export interface SystemInfo {
  ramGb: number;
  chip: string;
}
export async function systemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>("system_info");
}

/** Download a URL to a destination path (~ allowed), streaming progress. */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (line: string) => void
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (line) => onProgress(line);
  await invoke("download_file", { url, dest, onEvent: channel });
}

/** Pull an Ollama model, streaming progress lines. Resolves when finished. */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (line: string) => void
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (line) => onProgress(line);
  await invoke("pull_ollama_model", { baseUrl, model, onEvent: channel });
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
  return invoke<string>("generate_image", { params: args });
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
}

/** Returns a base64 PNG (no data-URI prefix). ComfyUI backend. */
export async function generateImageComfy(args: ComfyArgs): Promise<string> {
  return invoke<string>("generate_image_comfy", { params: args });
}

export async function listComfyCheckpoints(baseUrl: string): Promise<string[]> {
  return invoke<string[]>("list_comfy_checkpoints", { baseUrl });
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
}

/** Transform an uploaded image. Returns a base64 PNG (no prefix). */
export async function generateImg2imgComfy(args: Img2ImgArgs): Promise<string> {
  return invoke<string>("generate_img2img_comfy", { params: args });
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
  return invoke<string>("generate_image_openrouter", { params: args });
}

export interface OpenrouterEditArgs {
  apiKey: string;
  model: string;
  prompt: string;
  imageBase64: string; // source image, no data-URI prefix
}

/** Edit/transform an uploaded image via OpenRouter. Returns base64 (no prefix). */
export async function editImageOpenrouter(args: OpenrouterEditArgs): Promise<string> {
  return invoke<string>("edit_image_openrouter", { params: args });
}
