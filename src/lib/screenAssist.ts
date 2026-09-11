// One question to the screen assistant, start to finish.
//
// The whole interaction is a single model call. When you speak, the microphone
// audio goes to the model alongside the screenshot and it transcribes AND
// answers in one round trip — rather than transcribe, wait, then ask. That
// halves the latency of the thing you notice most, and it is why the model
// picker cares whether a model can hear.
import { chatCompletion, type AssistantMessage } from "./agent";
import {
  captureScreen,
  controlStatus,
  probeAssets,
  controlTrusted,
  listVoices,
  overlayPassClicks,
  speak,
  stopSpeaking,
  type MacVoice,
} from "./api";
import { CONTROL_TOOLS, describe, runTool, type Step } from "./control";
import { buildScreenAssistMessages, parseScreenAnswer, type ScreenAnswer } from "./presets";
import { assistProvider, type Settings } from "./settings";

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
  /** Let the model use the Mac — click, type, flip switches — to carry the
   *  request out, rather than only describing how. */
  act?: boolean;
  /** Called as each step starts and again when it finishes, so the overlay can
   *  show what is happening to the user's own machine in real time. */
  onStep?: (step: Step, done: boolean) => void;
  /** Checked between steps: true ends the run where it stands. */
  stopped?: () => boolean;
  /** Earlier exchanges in this sitting, oldest first. What makes "and now turn
   *  it back on" mean anything — without it every question starts from nothing
   *  and a follow-up is unanswerable. */
  history?: { q: string; a: string }[];
}

export interface AskResult extends ScreenAnswer {
  /** True when a screenshot was actually attached. */
  sawScreen: boolean;
  /** Everything that was actually done, in order. Empty when nothing was. */
  steps: Step[];
  /** True when the run hit the step limit or the user stopped it. */
  cutShort?: boolean;
  /** Set when the screen was asked for and could not be captured. Carried all
   *  the way out rather than folded into the answer: the model happily answers
   *  "I cannot see your screen", which reads as a limitation of the assistant
   *  rather than as a permission the user can go and grant. */
  captureError?: string;
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
    return { say: "", annotations: [], sawScreen: false, steps: [] };
  }
  const provider = assistProvider(settings);
  // No local model takes audio. Sending it anyway gets "Failed to load image or
  // audio file" out of Ollama, which reads like a broken app rather than a
  // model that simply has no ears.
  if (provider.local && input.clip) {
    throw new Error(
      `${provider.model} runs on this Mac and cannot hear — no local model can. ` +
        "Type the question instead, or pick a hosted model under ⚙."
    );
  }
  // Say which key is missing rather than letting OpenRouter answer with a bare
  // 401, which reads as "your key is wrong" when the real cause is that this
  // window never loaded it. A model running on this Mac needs no key at all.
  if (!provider.local && !provider.apiKey.trim()) {
    throw new Error(
      "No OpenRouter key available. Open AI Box → Settings and check the key is saved."
    );
  }

  // Acting needs eyes: the model has to see what it just did before it does the
  // next thing, and a blind agent clicking at remembered coordinates is worse
  // than one that refuses. It also needs Accessibility, which is the user's to
  // grant — so the run falls back to advice rather than failing, and says why.
  let act = !!input.act;
  let actNote = "";
  if (act && !input.withScreen) {
    act = false;
    actNote = "acting needs the screen attached";
  }
  if (act && !(await controlTrusted().catch(() => false))) {
    act = false;
    actNote =
      "AI Box is not switched on in System Settings → Privacy & Security → Accessibility, " +
      "so it cannot click or type yet";
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
    !!screenshot,
    act,
    actNote
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

  const messages: any[] = [{ role: "system", content: system }];
  // Earlier turns go in as plain text. Their screenshots deliberately do not:
  // the screen has moved on, and an old picture of it is worse than none.
  for (const turn of input.history ?? []) {
    messages.push({ role: "user", content: turn.q });
    messages.push({ role: "assistant", content: turn.a });
  }
  messages.push({ role: "user", content });

  // What the switches are set to right now, so "turn Bluetooth off" when it is
  // already off gets an honest answer instead of a pointless toggle, and so the
  // model knows which app it is about to be clicking in.
  if (act) {
    const status = await controlStatus().catch(() => null);
    if (status) {
      messages.push({
        role: "system",
        content:
          `Current state — Bluetooth: ${status.bluetooth}, Wi-Fi: ${status.wifi}, ` +
          `volume: ${status.volume}, appearance: ${status.appearance}, ` +
          `frontmost app: ${status.frontmostApp || "unknown"}.`,
      });
    }
  }

  const steps: Step[] = [];
  // 0 means no ceiling: the run ends when the model says it is done, or when
  // the user presses Escape. Nothing else stops it, by the user's choice.
  const max = settings.assistMaxSteps ?? 12;
  const limit = act ? (max <= 0 ? Infinity : max) : 1;
  let cutShort = false;
  let sawScreen = !!screenshot;

  try {
    for (let round = 0; round < limit; round++) {
      const msg = await chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages,
        tools: act ? (CONTROL_TOOLS as unknown as unknown[]) : [],
        // Low: this is a factual reading of a screen, not a creative task, and a
        // wandering model puts arrows on the wrong button — or clicks one.
        temperature: 0.2,
      });

      const calls = msg.tool_calls ?? [];
      if (!act || calls.length === 0) {
        const answer = parseScreenAnswer(msg.content ?? null);
        if (captureError && !answer.say) {
          answer.say = "I couldn't capture the screen.";
        }
        return { ...answer, sawScreen, steps, cutShort, captureError: captureError ?? undefined };
      }

      messages.push(msg);
      try {
        for (const call of calls) {
          if (cutShort || input.stopped?.()) {
            cutShort = true;
            // Every tool call has to be answered even when the run is over:
            // the API rejects a conversation where an assistant asked for a
            // tool and nothing ever came back, so stopping would poison the
            // wrap-up request that explains what happened.
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "Not run — the user stopped you.",
            });
            continue;
          }
          let args: any = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            /* a malformed argument blob is reported back as a failed step below */
          }
          const pending: Step = {
            tool: call.function.name,
            message: describe(call.function.name, args),
            ok: true,
          };
          steps.push(pending);
          input.onStep?.(pending, false);

          // The bar sits over the screen being clicked. It stops taking the
          // mouse for the length of this one action and takes it back straight
          // after, so between steps the Stop button is a real button again.
          await overlayPassClicks(true).catch(() => {});
          let done: Step;
          try {
            done = await runTool(call.function.name, args);
          } finally {
            await overlayPassClicks(false).catch(() => {});
          }
          steps[steps.length - 1] = done;
          input.onStep?.(done, true);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: done.ok ? done.message : `FAILED: ${done.message}`,
          });
        }

        // Look again. Acting without checking is how an agent ends up reporting
        // success at a dialog it never dismissed.
        if (!cutShort) {
          try {
            const shot = await captureScreen();
            sawScreen = true;
            dropOldScreenshots(messages);
            messages.push({
              role: "user",
              content: [
                { type: "text", text: "This is the screen now. Carry on, or answer if you are done." },
                { type: "image_url", image_url: { url: `data:image/png;base64,${shot}` } },
              ],
            });
          } catch (e) {
            messages.push({
              role: "user",
              content: `The screen could not be captured after that step: ${e}`,
            });
          }
        }
      } finally {
        await overlayPassClicks(false).catch(() => {});
      }

      if (cutShort) break;
    }

    // Out of steps, or stopped. Ask for a plain summary rather than inventing one:
    // only the model knows how far through its own plan it got.
    messages.push({
      role: "user",
      content: cutShort
        ? "I stopped you there. In one or two sentences, say what you did and what is left."
        : "That is as many steps as you get. In one or two sentences, say what you did and what is left.",
    });
    const wrap = await chatCompletion({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: settings.openrouterKey,
      model: settings.assistModel,
      messages,
      tools: [],
      temperature: 0.2,
    });
    const answer = parseScreenAnswer(wrap.content ?? null);
    return { ...answer, sawScreen, steps, cutShort: true };
  } finally {
    // A run that ended badly must never leave the bar unable to take a click.
    await overlayPassClicks(false).catch(() => {});
  }
}

/**
 * Keep only the newest screenshot in the conversation.
 *
 * Every round adds a full-screen PNG, and a ten-step run would otherwise carry
 * ten of them into every request — slow, expensive, and actively misleading,
 * since the model starts reasoning about a screen that is three clicks out of
 * date. The older ones become a line of text saying they were there.
 */
function dropOldScreenshots(messages: any[]): void {
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    if (!m.content.some((c: any) => c?.type === "image_url")) continue;
    const text = m.content.find((c: any) => c?.type === "text")?.text ?? "";
    m.content = [{ type: "text", text: `${text} (that screenshot is out of date and was removed)` }];
  }
}

/** Installed voices, fetched once — the list only changes when macOS does. */
let voiceCache: MacVoice[] | null = null;
async function voices(): Promise<MacVoice[]> {
  if (!voiceCache) voiceCache = await listVoices().catch(() => []);
  return voiceCache;
}

/**
 * Speak an answer in a voice that actually speaks its language.
 *
 * Never throws: speech is a nicety, and the text is already on screen.
 */
export async function say(settings: Settings, text: string, lang?: string): Promise<void> {
  if (!settings.assistSpeak || !text.trim()) return;
  try {
    const voice = voiceForLanguage(await voices(), lang, settings.assistVoice);
    await speak(text, voice, settings.assistRate);
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

  /** Containers to record in, best first. What is SENT is always WAV — see
   *  `stop` — so this only decides what the browser captures into. */
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

    // Converted to WAV rather than sent as recorded. The OpenAI audio schema
    // names exactly two formats, wav and mp3; Google happily takes the WebM
    // this webview produces, and a strict provider rejects the whole message
    // with "data did not match any variant of untagged enum
    // ChatCompletionRequestUserMessageContent" — which reads like a bug in the
    // app rather than an unsupported container. Converting once here means the
    // recording works everywhere instead of on whichever provider is lenient.
    const wav = await toWav(blob).catch(() => null);
    if (wav) return wav;
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

/**
 * Decode whatever the browser recorded and re-encode it as 16 kHz mono WAV.
 *
 * Mono because speech is, and 16 kHz because that is what speech models resample
 * to anyway — together they keep a WAV, which is uncompressed, roughly the size
 * of the compressed original rather than ten times it.
 */
async function toWav(blob: Blob): Promise<Clip> {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const pcm = resampleToMono(decoded, 16000);
    return { data: await blobToBase64(encodeWav(pcm, 16000)), format: "wav" };
  } finally {
    void ctx.close();
  }
}

/** Average the channels together and resample, linearly, to `rate`. */
function resampleToMono(buffer: AudioBuffer, rate: number): Float32Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const ratio = buffer.sampleRate / rate;
  const out = new Float32Array(Math.max(1, Math.floor(buffer.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, buffer.length - 1);
    const t = at - low;
    let sum = 0;
    for (const ch of channels) sum += ch[low] * (1 - t) + ch[high] * t;
    out[i] = sum / channels.length;
  }
  return out;
}

/** 16-bit PCM WAV, the one container every provider in the OpenAI schema takes. */
function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample just past ±1 would otherwise wrap round
    // to the opposite extreme and click.
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
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

// ---- dictation --------------------------------------------------------------

/**
 * Turn a recording into text.
 *
 * Deliberately separate from `ask`: in Agentic Chat the transcript goes into the
 * composer for the user to read and edit BEFORE it is sent, rather than straight
 * to the model. That agent can run shell commands and rewrite files, and acting
 * on a misheard instruction that nobody saw is a bad trade for saving one
 * keystroke. It also means dictation works with any chat model, including local
 * Ollama ones that cannot hear a thing.
 *
 * Uses the Screen Assist model, which the picker already guarantees is
 * audio-capable, rather than adding a second model setting to configure.
 */
export async function transcribe(settings: Settings, clip: Clip): Promise<string> {
  const provider = assistProvider(settings);
  if (!provider.local && !provider.apiKey.trim()) {
    throw new Error("Dictation needs your OpenRouter key — add it in Settings.");
  }
  const msg = await chatCompletion({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      {
        role: "system",
        content:
          "Transcribe the audio verbatim. Output ONLY the words spoken — no " +
          "preamble, no quotation marks, no commentary, no translation. If the " +
          "audio contains no discernible speech, output nothing at all.",
      },
      {
        role: "user",
        content: [{ type: "input_audio", input_audio: { data: clip.data, format: clip.format } }],
      },
    ],
    tools: [],
    // Zero: this is a transcription, and any creativity here is a misquote.
    temperature: 0,
  });
  return (msg.content ?? "").trim();
}

/**
 * The best installed voice for a language.
 *
 * macOS voices carry their language: Samantha reads German with English
 * phonetics and Anna reads English with German ones, so the voice has to follow
 * the answer rather than be fixed once in settings. Siri's own language setting
 * is irrelevant here — `say` never consults it.
 *
 * A voice the user picked explicitly wins, but only while it speaks the right
 * language; otherwise the best match is chosen, preferring Apple's Premium and
 * Enhanced voices, which `listVoices` already sorts to the front.
 */
export function voiceForLanguage(
  voices: MacVoice[],
  lang: string | undefined,
  preferred: string
): string {
  const code = (lang ?? "").slice(0, 2).toLowerCase();
  const chosen = voices.find((v) => v.name === preferred);
  if (chosen && (!code || chosen.locale.slice(0, 2).toLowerCase() === code)) {
    return chosen.name;
  }
  if (!code) return preferred;
  // listVoices() is already ordered best-quality-first within a language.
  return voices.find((v) => v.locale.slice(0, 2).toLowerCase() === code)?.name ?? preferred;
}

// ---- checking a model -------------------------------------------------------

/**
 * Does this model actually work here?
 *
 * Built from the same prompt builder, the same tools and the same parser as a
 * real question, so what is checked is what will run. An earlier version
 * reimplemented a simplified request and drifted from it immediately: it asked
 * one thing in text and another in audio, and threw out a good model for
 * answering the audio.
 *
 * Two questions, because they fail independently. One spoken question about a
 * picture — a model that returns nothing to say leaves the overlay blank. One
 * instruction to do something — a model that answers but never calls a tool
 * leaves acting silently doing nothing.
 *
 * Nothing is executed: the tool call is inspected and thrown away, so checking a
 * model never touches the Mac.
 */
export async function checkModel(settings: Settings, model: string): Promise<void> {
  const probe = await probeAssets();
  const provider = assistProvider({ ...settings, assistModel: model });
  // A local model has no ears, and the picker does not pretend otherwise.
  const canHear = !provider.local && !!probe.audio;

  const ask = async (
    question: string,
    acting: boolean,
    clip: Clip | null
  ): Promise<AssistantMessage> => {
    const { system, user } = buildScreenAssistMessages(question, true, acting);
    const content: unknown[] = [
      { type: "text", text: user },
      { type: "image_url", image_url: { url: `data:image/png;base64,${probe.image}` } },
    ];
    if (clip) {
      content.push({ type: "input_audio", input_audio: { data: clip.data, format: clip.format } });
    }
    return withTimeout(
      chatCompletion({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content },
        ],
        tools: acting ? (CONTROL_TOOLS as unknown as unknown[]) : [],
        temperature: 0.2,
      }),
      acting ? "taking an action" : "answering a question"
    );
  };

  const spoken = await ask(
    canHear ? "(the user's question is in the attached audio)" : "Describe this screen in one short sentence.",
    false,
    canHear ? { data: probe.audio as string, format: "wav" } : null
  );
  if (!parseScreenAnswer(spoken.content ?? null).say.trim()) {
    throw new Error("That model returned nothing to say — its answers would come out blank.");
  }

  const acted = await ask("Turn Bluetooth off.", true, null);
  if (!(acted.tool_calls ?? []).length) {
    throw new Error(
      "That model answers questions but will not use a tool, so it could never act on your Mac."
    );
  }
}

/** A model slower than this is not usable as a live overlay, whatever it says. */
const CHECK_TIMEOUT_MS = 60_000;

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`That model took over a minute ${what}, which is too slow to ask.`)),
        CHECK_TIMEOUT_MS
      )
    ),
  ]);
}
