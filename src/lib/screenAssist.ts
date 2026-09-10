// One question to the screen assistant, start to finish.
//
// The whole interaction is a single model call. When you speak, the microphone
// audio goes to the model alongside the screenshot and it transcribes AND
// answers in one round trip — rather than transcribe, wait, then ask. That
// halves the latency of the thing you notice most, and it is why the model
// picker cares whether a model can hear.
import { chatCompletion } from "./agent";
import { captureScreen, speak, stopSpeaking } from "./api";
import { buildScreenAssistMessages, parseScreenAnswer, type ScreenAnswer } from "./presets";
import type { Settings } from "./settings";

/** Audio captured from the microphone, ready to send. */
export interface Clip {
  /** base64, no data-URI prefix. */
  data: string;
  /** The `input_audio.format` value: "wav", "webm", "mp3"… */
  format: string;
}

export interface AskInput {
  /** Typed question. Empty when the question was spoken. */
  text: string;
  clip?: Clip | null;
  /** Attach a fresh screenshot to this question. */
  withScreen: boolean;
}

export interface AskResult extends ScreenAnswer {
  /** True when a screenshot was actually attached. */
  sawScreen: boolean;
}

/**
 * Ask one question and get the answer, with the screen attached if asked for.
 *
 * A capture failure is deliberately NOT fatal: the usual cause is the Screen
 * Recording permission not being granted yet, and answering the question
 * without eyes beats refusing to answer at all. The caller is told what
 * happened via `sawScreen`.
 */
export async function ask(settings: Settings, input: AskInput): Promise<AskResult> {
  const question = input.text.trim();
  if (!question && !input.clip) {
    return { say: "", annotations: [], sawScreen: false };
  }

  let screenshot: string | null = null;
  let captureError: string | null = null;
  if (input.withScreen) {
    try {
      screenshot = await captureScreen();
    } catch (e) {
      captureError = String(e);
    }
  }

  const { system, user } = buildScreenAssistMessages(
    question || "(the user's question is in the attached audio)",
    !!screenshot
  );

  // OpenAI-shaped multimodal content: text first so the instruction is read
  // before the pixels, then the screenshot, then the audio.
  const content: unknown[] = [{ type: "text", text: user }];
  if (screenshot) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${screenshot}` },
    });
  }
  if (input.clip) {
    content.push({
      type: "input_audio",
      input_audio: { data: input.clip.data, format: input.clip.format },
    });
  }

  const msg = await chatCompletion({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: settings.openrouterKey,
    model: settings.assistModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content },
    ],
    tools: [],
    // Low: this is a factual reading of a screen, not a creative task, and a
    // wandering model puts arrows on the wrong button.
    temperature: 0.2,
  });

  const answer = parseScreenAnswer(msg.content ?? null);
  if (captureError && !answer.say) {
    answer.say = "I couldn't capture the screen. " + captureError;
  }
  return { ...answer, sawScreen: !!screenshot };
}

/** Speak an answer, if speech is on. Never throws — a mute answer still shows. */
export async function say(settings: Settings, text: string): Promise<void> {
  if (!settings.assistSpeak || !text.trim()) return;
  try {
    await speak(text, settings.assistVoice, settings.assistRate);
  } catch {
    /* speech is a nicety; the text is already on screen */
  }
}

export async function hush(): Promise<void> {
  try {
    await stopSpeaking();
  } catch {
    /* nothing was speaking */
  }
}

// ---- microphone ------------------------------------------------------------

/**
 * Push-to-talk recorder.
 *
 * The format is negotiated rather than assumed: Safari's MediaRecorder (which
 * is what the Tauri webview is) supports a different set from Chrome's, and
 * OpenRouter needs the `format` field to match the bytes. Asking the browser
 * what it will actually produce avoids sending mp4 bytes labelled webm.
 */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;

  /** Formats OpenRouter accepts, best first. */
  private static readonly CANDIDATES = [
    { mime: "audio/webm;codecs=opus", format: "webm" },
    { mime: "audio/webm", format: "webm" },
    { mime: "audio/mp4", format: "m4a" },
    { mime: "audio/mpeg", format: "mp3" },
    { mime: "audio/wav", format: "wav" },
  ];

  private format = "webm";

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const pick =
      Recorder.CANDIDATES.find(
        (c) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mime)
      ) ?? null;
    this.format = pick?.format ?? "webm";
    this.chunks = [];
    this.recorder = new MediaRecorder(
      this.stream,
      pick ? { mimeType: pick.mime } : undefined
    );
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop and hand back the clip, or null if nothing was captured. */
  async stop(): Promise<Clip | null> {
    const rec = this.recorder;
    if (!rec) return null;
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    if (rec.state !== "inactive") rec.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;

    const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
    this.chunks = [];
    // A tap rather than a hold produces a few hundred bytes of silence; sending
    // that wastes a call and gets a confused answer back.
    if (blob.size < 1200) return null;
    return { data: await blobToBase64(blob), format: this.format };
  }

  /** Throw the recording away without sending it. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("could not read the recording"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1)); // drop the data: prefix
    };
    reader.readAsDataURL(blob);
  });
}
