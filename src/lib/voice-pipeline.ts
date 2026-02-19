// Voice pipeline: Deepgram Unified Voice Agent API (single WebSocket)
// wss://agent.deepgram.com/v1/agent/converse
// Handles STT + LLM + TTS in one connection with native barge-in

const DEEPGRAM_KEY = import.meta.env.VITE_DEEPGRAM_API_KEY;

export type PipelineState = "idle" | "listening" | "thinking" | "speaking";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
}

interface PipelineCallbacks {
  onStateChange: (state: PipelineState) => void;
  onInterimTranscript: (text: string) => void;
  onFinalTranscript: (entry: TranscriptEntry) => void;
  onError: (error: string) => void;
  onAudioLevel: (level: number) => void;
  onWaveformData: (data: number[]) => void;
}

export class VoicePipeline {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentGainNode: GainNode | null = null;
  private animationFrame: number | null = null;
  private socket: WebSocket | null = null;
  private callbacks: PipelineCallbacks;
  private isRunning = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECTS = 5;

  // Audio playback buffer system
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private pendingAudioChunks: Int16Array[] = [];
  private readonly BUFFER_SIZE = 3200; // samples per buffer chunk
  private pendingSamples = 0;

  constructor(callbacks: PipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start() {
    if (this.isRunning) return;

    if (!DEEPGRAM_KEY) {
      this.callbacks.onError("Missing API key. Set VITE_DEEPGRAM_API_KEY in your environment.");
      return;
    }

    this.isRunning = true;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      this.playbackContext = new AudioContext({ sampleRate: 24000 });

      await this.audioContext.resume();
      await this.playbackContext.resume();

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Analyser for visual waveform
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.sourceNode.connect(this.analyser);
      this.monitorAudio();

      // ScriptProcessor to capture raw PCM and send to agent
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.silentGainNode = this.audioContext.createGain();
      this.silentGainNode.gain.value = 0;

      this.sourceNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.silentGainNode);
      this.silentGainNode.connect(this.audioContext.destination);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isRunning || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.socket.send(int16.buffer);
      };

      this.connectAgent();
    } catch (err) {
      console.error("[KIMI] Mic error:", err);
      this.callbacks.onError("Microphone access denied or unavailable.");
      this.stop();
    }
  }

  private monitorAudio() {
    if (!this.analyser) return;
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    const timeData = new Uint8Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.analyser || !this.isRunning) return;

      this.analyser.getByteFrequencyData(freqData);
      const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;
      this.callbacks.onAudioLevel(avg / 255);

      this.analyser.getByteTimeDomainData(timeData);
      const waveform: number[] = [];
      const step = Math.floor(timeData.length / 64);
      for (let i = 0; i < 64; i++) {
        waveform.push((timeData[i * step] - 128) / 128);
      }
      this.callbacks.onWaveformData(waveform);

      this.animationFrame = requestAnimationFrame(tick);
    };

    tick();
  }

  private connectAgent() {
    if (!this.isRunning || !DEEPGRAM_KEY) return;

    console.log("[KIMI Agent] Connecting to Deepgram Voice Agent...");

    const url = "wss://agent.deepgram.com/v1/agent/converse";
    this.socket = new WebSocket(url, ["token", DEEPGRAM_KEY]);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      console.log("[KIMI Agent] WebSocket open, sending settings...");

      const settings = {
        type: "Settings",
        audio: {
          input: {
            encoding: "linear16",
            sample_rate: 16000,
          },
          output: {
            encoding: "linear16",
            sample_rate: 24000,
            container: "none",
          },
        },
        agent: {
          listen: {
            provider: {
              type: "deepgram",
              model: "nova-3",
            },
          },
          think: {
            provider: { type: "open_ai", model: "gpt-4o-mini" },
            instructions:
              "You are KIMI, a cutting-edge AI voice assistant. Be concise, natural, and helpful. Keep each response short and clear.",
          },
          speak: {
            provider: {
              type: "deepgram",
              model: "aura-asteria-en",
            },
          },
          greeting: "Hello, I am KIMI. How can I help you?",
        },
      };

      this.socket?.send(JSON.stringify(settings));
    };

    this.socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleAudioChunk(new Int16Array(event.data));
        return;
      }

      if (event.data instanceof Blob) {
        void this.handleAudioBlob(event.data);
        return;
      }

      try {
        const msg = JSON.parse(event.data as string);
        this.handleAgentMessage(msg);
      } catch (err) {
        console.error("[KIMI Agent] Parse error:", err);
      }
    };

    this.socket.onerror = (err) => {
      console.error("[KIMI Agent] WebSocket error:", err);
      this.callbacks.onError("Voice agent connection error.");
    };

    this.socket.onclose = (event) => {
      console.log("[KIMI Agent] Closed:", event.code, event.reason);
      if (this.isRunning && this.reconnectAttempts < this.MAX_RECONNECTS) {
        this.reconnectAttempts++;
        console.log(
          `[KIMI Agent] Reconnecting (${this.reconnectAttempts}/${this.MAX_RECONNECTS}) in 1s...`,
        );
        setTimeout(() => this.connectAgent(), 1000);
      } else if (this.reconnectAttempts >= this.MAX_RECONNECTS) {
        console.error("[KIMI Agent] Max reconnects reached, stopping.");
        this.callbacks.onError("Connection lost. Please restart the call.");
        this.stop();
      }
    };
  }

  private handleAgentMessage(msg: any) {
    const type = msg.type;

    switch (type) {
      case "Welcome":
        console.log("[KIMI Agent] Welcome received");
        break;

      case "SettingsApplied":
        console.log("[KIMI Agent] Settings applied");
        this.reconnectAttempts = 0;
        this.callbacks.onStateChange("listening");
        break;

      case "UserStartedSpeaking":
        this.interruptPlayback();
        this.callbacks.onStateChange("listening");
        break;

      case "UserTranscript":
      case "Transcript":
      case "ConversationText":
        this.handleTranscriptMessage(msg);
        break;

      case "UserTranscriptInterim":
      case "TranscriptInterim": {
        const interim = this.extractText(msg);
        if (interim) {
          this.callbacks.onInterimTranscript(interim);
          this.callbacks.onStateChange("listening");
        }
        break;
      }

      case "AgentThinking":
        this.callbacks.onStateChange("thinking");
        break;

      case "AgentStartedSpeaking":
        this.callbacks.onStateChange("speaking");
        break;

      case "AgentAudioDone":
        this.flushAudioBuffer();
        break;

      case "Error":
        this.callbacks.onError(msg.description || msg.message || "Voice agent error.");
        break;

      default:
        console.log("[KIMI Agent] Event:", type, msg);
    }
  }

  private handleTranscriptMessage(msg: any) {
    const text = this.extractText(msg);
    if (!text) return;

    const isInterim = Boolean(msg.is_interim || msg.interim);
    if (isInterim) {
      this.callbacks.onInterimTranscript(text);
      return;
    }

    this.callbacks.onInterimTranscript("");

    const roleRaw = (msg.role || msg.speaker || "assistant") as string;
    const role: "user" | "assistant" = roleRaw === "user" ? "user" : "assistant";

    this.callbacks.onFinalTranscript({
      role,
      text,
      timestamp: new Date(),
    });
  }

  private extractText(msg: any): string {
    const candidates = [
      msg?.content,
      msg?.text,
      msg?.transcript,
      msg?.message,
      msg?.delta,
      msg?.channel?.alternatives?.[0]?.transcript,
    ];

    const found = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
    return (found || "").trim();
  }

  private async handleAudioBlob(blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    this.handleAudioChunk(new Int16Array(arrayBuffer));
  }

  private handleAudioChunk(int16: Int16Array) {
    if (!int16.length) return;

    this.pendingAudioChunks.push(int16);
    this.pendingSamples += int16.length;

    if (this.pendingSamples >= this.BUFFER_SIZE) {
      this.flushAudioBuffer();
    }
  }

  private flushAudioBuffer() {
    if (!this.playbackContext || this.pendingAudioChunks.length === 0) return;

    const totalLength = this.pendingAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Int16Array(totalLength);
    let offset = 0;

    for (const chunk of this.pendingAudioChunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    this.pendingAudioChunks = [];
    this.pendingSamples = 0;

    const float32 = new Float32Array(combined.length);
    for (let i = 0; i < combined.length; i++) {
      float32[i] = combined[i] / 32768;
    }

    const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    this.audioQueue.push(audioBuffer);

    if (!this.isPlaying) {
      this.playNextBuffer();
    }
  }

  private playNextBuffer() {
    if (!this.playbackContext || this.audioQueue.length === 0) {
      this.isPlaying = false;
      if (this.isRunning) this.callbacks.onStateChange("listening");
      return;
    }

    this.isPlaying = true;
    const buffer = this.audioQueue.shift();
    if (!buffer) {
      this.isPlaying = false;
      return;
    }

    const source = this.playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackContext.destination);
    this.currentSource = source;

    source.onended = () => {
      this.currentSource = null;
      this.playNextBuffer();
    };

    source.start();
  }

  private interruptPlayback() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (_) {
        // no-op
      }
      this.currentSource = null;
    }

    this.audioQueue = [];
    this.pendingAudioChunks = [];
    this.pendingSamples = 0;
    this.isPlaying = false;
  }

  stop() {
    this.isRunning = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    this.interruptPlayback();

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.silentGainNode) {
      this.silentGainNode.disconnect();
      this.silentGainNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
      this.socket = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    if (this.playbackContext) {
      void this.playbackContext.close();
      this.playbackContext = null;
    }

    this.callbacks.onInterimTranscript("");
    this.callbacks.onStateChange("idle");
    this.callbacks.onAudioLevel(0);
    this.callbacks.onWaveformData([]);
    console.log("[KIMI] Stopped");
  }
}
