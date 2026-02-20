// Voice pipeline: Deepgram Unified Voice Agent API
// Single WebSocket handles STT + LLM + TTS with native barge-in
import type {} from "livekit-client"; // keep dep to avoid build error

const DEEPGRAM_KEY = "3509fd08965bd3e0d97585827ab5291c15f75364";

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
  private readonly MAX_RECONNECTS = 3;

  // Audio playback
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private pendingAudioChunks: Int16Array[] = [];
  private pendingSamples = 0;
  private readonly BUFFER_SIZE = 3200;

  constructor(callbacks: PipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start() {
    if (this.isRunning) return;
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

      // Analyser for waveform visualization
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.sourceNode.connect(this.analyser);
      this.monitorAudio();

      // ScriptProcessor to capture PCM and send to Deepgram
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
      this.callbacks.onError("Microphone access denied. Please allow mic access and try again.");
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
      this.callbacks.onAudioLevel(freqData.reduce((a, b) => a + b, 0) / freqData.length / 255);

      this.analyser.getByteTimeDomainData(timeData);
      const waveform: number[] = [];
      const step = Math.floor(timeData.length / 64);
      for (let i = 0; i < 64; i++) waveform.push((timeData[i * step] - 128) / 128);
      this.callbacks.onWaveformData(waveform);

      this.animationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private connectAgent() {
    if (!this.isRunning) return;
    console.log("[KIMI] Connecting to Deepgram Voice Agent...");

    this.socket = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", ["token", DEEPGRAM_KEY]);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      console.log("[KIMI] Connected, sending settings...");
      this.socket?.send(JSON.stringify({
        type: "Settings",
        audio: {
          input: { encoding: "linear16", sample_rate: 16000 },
          output: { encoding: "linear16", sample_rate: 24000, container: "none" },
        },
        agent: {
          listen: { provider: { type: "deepgram", model: "nova-3" } },
          think: {
            provider: { type: "open_ai", model: "gpt-4o-mini" },
            instructions: "You are ROX, a cutting-edge AI voice assistant. Be concise, natural, and helpful. Keep responses short and clear. Never repeat yourself.",
          },
          speak: { provider: { type: "deepgram", model: "aura-asteria-en" } },
          greeting: "Hello, I am ROX. How can I help you?",
        },
      }));
    };

    this.socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.handleAudioChunk(new Int16Array(event.data));
        return;
      }
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buf => this.handleAudioChunk(new Int16Array(buf)));
        return;
      }
      try {
        this.handleAgentMessage(JSON.parse(event.data as string));
      } catch {}
    };

    this.socket.onerror = () => this.callbacks.onError("Voice agent connection error.");

    this.socket.onclose = (e) => {
      console.log("[KIMI] Closed:", e.code, e.reason);
      if (this.isRunning && this.reconnectAttempts < this.MAX_RECONNECTS) {
        this.reconnectAttempts++;
        setTimeout(() => this.connectAgent(), 1000);
      } else if (this.reconnectAttempts >= this.MAX_RECONNECTS) {
        this.callbacks.onError("Connection lost. Please restart.");
        this.stop();
      }
    };
  }

  private handleAgentMessage(msg: any) {
    switch (msg.type) {
      case "SettingsApplied":
        this.reconnectAttempts = 0;
        this.callbacks.onStateChange("listening");
        break;
      case "UserStartedSpeaking":
        this.interruptPlayback();
        this.callbacks.onStateChange("listening");
        break;
      case "ConversationText":
        this.handleTranscript(msg);
        break;
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
        this.callbacks.onError(msg.description || msg.message || "Agent error");
        break;
      default:
        console.log("[KIMI] Event:", msg.type);
    }
  }

  private handleTranscript(msg: any) {
    const text = msg.content || msg.text || msg.transcript || "";
    if (!text.trim()) return;

    const role: "user" | "assistant" = msg.role === "user" ? "user" : "assistant";
    this.callbacks.onInterimTranscript("");
    this.callbacks.onFinalTranscript({ role, text: text.trim(), timestamp: new Date() });
  }

  private handleAudioChunk(int16: Int16Array) {
    if (!int16.length) return;
    this.pendingAudioChunks.push(int16);
    this.pendingSamples += int16.length;
    if (this.pendingSamples >= this.BUFFER_SIZE) this.flushAudioBuffer();
  }

  private flushAudioBuffer() {
    if (!this.playbackContext || !this.pendingAudioChunks.length) return;

    const total = this.pendingAudioChunks.reduce((s, c) => s + c.length, 0);
    const combined = new Int16Array(total);
    let offset = 0;
    for (const chunk of this.pendingAudioChunks) { combined.set(chunk, offset); offset += chunk.length; }
    this.pendingAudioChunks = [];
    this.pendingSamples = 0;

    const float32 = new Float32Array(combined.length);
    for (let i = 0; i < combined.length; i++) float32[i] = combined[i] / 32768;

    const buf = this.playbackContext.createBuffer(1, float32.length, 24000);
    buf.getChannelData(0).set(float32);
    this.audioQueue.push(buf);
    if (!this.isPlaying) this.playNextBuffer();
  }

  private playNextBuffer() {
    if (!this.playbackContext || !this.audioQueue.length) {
      this.isPlaying = false;
      if (this.isRunning) this.callbacks.onStateChange("listening");
      return;
    }
    this.isPlaying = true;
    const buf = this.audioQueue.shift()!;
    const source = this.playbackContext.createBufferSource();
    source.buffer = buf;
    source.connect(this.playbackContext.destination);
    this.currentSource = source;
    source.onended = () => { this.currentSource = null; this.playNextBuffer(); };
    source.start();
  }

  private interruptPlayback() {
    try { this.currentSource?.stop(); } catch {}
    this.currentSource = null;
    this.audioQueue = [];
    this.pendingAudioChunks = [];
    this.pendingSamples = 0;
    this.isPlaying = false;
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrame) { cancelAnimationFrame(this.animationFrame); this.animationFrame = null; }
    this.interruptPlayback();
    this.scriptProcessor?.disconnect();
    this.silentGainNode?.disconnect();
    this.sourceNode?.disconnect();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
    this.socket = null;
    this.mediaStream?.getTracks().forEach(t => t.stop());
    if (this.audioContext) void this.audioContext.close();
    if (this.playbackContext) void this.playbackContext.close();
    this.audioContext = null;
    this.playbackContext = null;
    this.mediaStream = null;
    this.scriptProcessor = null;
    this.silentGainNode = null;
    this.sourceNode = null;
    this.callbacks.onInterimTranscript("");
    this.callbacks.onStateChange("idle");
    this.callbacks.onAudioLevel(0);
    this.callbacks.onWaveformData([]);
  }
}
