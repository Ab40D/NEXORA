"use client";

/**
 * Records ONE short utterance from the microphone (MediaRecorder), for local speech-to-text on
 * the SE7ENX hub. Starts only from an explicit user action, stops automatically after a pause
 * in speech or at a hard time limit, and releases the microphone immediately afterwards.
 * Nothing is uploaded until the recording ends; nothing is kept in the browser.
 *
 * End of speech: the noise floor is measured during the first 300 ms; speech is any level
 * clearly above it. After speech started, `silenceMs` of quiet ends the recording.
 */

export interface RecordOptions {
  maxMs: number;
  silenceMs?: number;
  /** called ~20×/s with the input level 0..1 (for a level meter) */
  onLevel?: (level: number) => void;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  speechDetected: boolean;
}

export interface RecordingHandle {
  done: Promise<Recording>;
  /** end now and keep what was recorded */
  stop: () => void;
  /** end now and discard */
  abort: () => void;
}

export class RecorderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

export function recorderSupported(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export function startRecording(opts: RecordOptions): RecordingHandle {
  let stopRequested = false;
  let aborted = false;
  let stopNow: (() => void) | null = null;

  const done = (async (): Promise<Recording> => {
    if (!recorderSupported()) throw new RecorderError("unsupported", "Recording audio is not supported in this browser.");
    if (!window.isSecureContext) throw new RecorderError("insecure", "The microphone requires HTTPS (or localhost).");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      const name = (err as DOMException)?.name ?? "Error";
      throw new RecorderError(name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : name === "NotFoundError" ? "audio-capture" : name, name);
    }
    const mimeType = pickMimeType();
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = AudioCtx ? new AudioCtx() : null;
    const analyser = ctx?.createAnalyser() ?? null;
    if (ctx && analyser) {
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
    }
    const buf = new Float32Array(1024);
    const started = performance.now();
    let floor = 0;
    let floorSamples = 0;
    let speechAt: number | null = null;
    let lastLoudAt = 0;
    const silenceMs = opts.silenceMs ?? 1000;

    const finished = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    const finish = () => {
      if (rec.state !== "inactive") rec.stop();
    };
    stopNow = finish;
    if (stopRequested || aborted) finish();

    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - started >= opts.maxMs) return finish();
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      opts.onLevel?.(Math.min(1, rms * 8));
      if (now - started < 300) {
        floor = (floor * floorSamples + rms) / (floorSamples + 1);
        floorSamples++;
        return;
      }
      const threshold = Math.max(0.012, floor * 3);
      if (rms > threshold) {
        lastLoudAt = now;
        if (speechAt === null) speechAt = now;
      } else if (speechAt !== null && now - lastLoudAt > silenceMs) {
        finish();
      }
    }, 50);

    rec.start(250);
    try {
      await finished;
    } finally {
      window.clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
    }
    if (aborted) throw new RecorderError("aborted", "Recording cancelled.");
    const type = rec.mimeType || mimeType || "audio/webm";
    return {
      blob: new Blob(chunks, { type }),
      mimeType: type,
      durationMs: Math.round(performance.now() - started),
      // without an analyser we cannot tell: let the speech service decide
      speechDetected: analyser ? speechAt !== null : true,
    };
  })();

  return {
    done,
    stop: () => {
      stopRequested = true;
      stopNow?.();
    },
    abort: () => {
      aborted = true;
      stopNow?.();
    },
  };
}
