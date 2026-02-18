// Voice pipeline: Deepgram STT (WebSocket) → Fireworks LLM → Deepgram TTS
// Rebuilt for phone-call speed with interruption support

const DEEPGRAM_KEY = "3509fd08965bd3e0d97585827ab5291c15f75364";
const FIREWORKS_KEY = "fw_Uvswjw47Hd39egTHkMEqwV";
const FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2-instruct-0905";

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
  private analyser: AnalyserNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private animationFrame: number | null = null;
  private socket: WebSocket | null = null;
  private conversationHistory: { role: string; content: string }[] = [];
  private callbacks: PipelineCallbacks;
  private isRunning = false;
  private currentAudio: HTMLAudioElement | null = null;
  private pendingFinals: string[] = [];
  private utteranceTimer: ReturnType<typeof setTimeout> | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private sttReconnecting = false;

  constructor(callbacks: PipelineCallbacks) {
    this.callbacks = callbacks;
    this.conversationHistory = [
      {
        role: "system",
        content:
          "You are KIMI, a cutting-edge AI voice assistant. Be extremely concise—respond in ONE short sentence max. Speak naturally like a phone call. Be warm but ultra-brief.",
      },
    ];
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
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Analyser for visual waveform
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.sourceNode.connect(this.analyser);
      this.monitorAudio();

      // ScriptProcessor to get raw PCM and send to Deepgram
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.sourceNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext.destination);

      this.scriptProcessor.onaudioprocess = (e) => {
        if (!this.isRunning || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert float32 to int16 PCM
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.socket.send(int16.buffer);
      };

      this.connectSTT();
    } catch (err: any) {
      console.error("[KIMI] Mic error:", err);
      this.callbacks.onError("Microphone access denied.");
      this.stop();
    }
  }

  private monitorAudio() {
    if (!this.analyser) return;
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    const timeData = new Uint8Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.analyser || !this.isRunning) return;

      // Frequency data for level
      this.analyser.getByteFrequencyData(freqData);
      const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;
      this.callbacks.onAudioLevel(avg / 255);

      // Time-domain data for waveform
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

  private connectSTT() {
    if (!this.isRunning) return;
    console.log("[KIMI STT] Connecting...");

    const url = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&interim_results=true&utterance_end_ms=2000&vad_events=true&endpointing=800&encoding=linear16&sample_rate=16000&channels=1`;

    this.socket = new WebSocket(url, ["token", DEEPGRAM_KEY]);

    this.socket.onopen = () => {
      console.log("[KIMI STT] Connected");
      this.sttReconnecting = false;
      this.callbacks.onStateChange("listening");

      // Send keepalive every 8s to prevent timeout
      this.keepAliveInterval = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 8000);
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "Results") {
          const alt = data.channel?.alternatives?.[0];
          if (!alt || !alt.transcript) return;

          const text = alt.transcript.trim();
          if (!text) return;

          if (data.is_final) {
            console.log("[KIMI STT] Final:", text);
            this.pendingFinals.push(text);

            // If user speaks while AI is talking, interrupt
            if (this.currentAudio) {
              console.log("[KIMI] Interrupting TTS");
              this.interruptTTS();
            }

            // Debounce: wait for silence before processing
            if (this.utteranceTimer) clearTimeout(this.utteranceTimer);
            this.utteranceTimer = setTimeout(() => {
              if (this.pendingFinals.length > 0 && !this.isProcessing) {
                const fullText = this.pendingFinals.join(" ").trim();
                this.pendingFinals = [];
                if (fullText) this.handleUserUtterance(fullText);
              }
            }, 1200);
          } else {
            this.callbacks.onInterimTranscript(text);

            // Interrupt on interim speech too (only on substantial speech)
            if (this.currentAudio && text.split(" ").length >= 3) {
              console.log("[KIMI] Interrupting TTS (interim)");
              this.interruptTTS();
            }
          }
        }

        if (data.type === "UtteranceEnd") {
          console.log("[KIMI STT] Utterance ended");
          // Process pending finals immediately
          if (this.pendingFinals.length > 0 && !this.isProcessing) {
            if (this.utteranceTimer) clearTimeout(this.utteranceTimer);
            const fullText = this.pendingFinals.join(" ").trim();
            this.pendingFinals = [];
            if (fullText) this.handleUserUtterance(fullText);
          }
        }
      } catch (err) {
        console.error("[KIMI STT] Parse error:", err);
      }
    };

    this.socket.onerror = (err) => {
      console.error("[KIMI STT] Error:", err);
    };

    this.socket.onclose = (event) => {
      console.log("[KIMI STT] Closed:", event.code, event.reason);
      if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);

      // Auto-reconnect if still running
      if (this.isRunning && !this.sttReconnecting) {
        this.sttReconnecting = true;
        console.log("[KIMI STT] Reconnecting in 500ms...");
        setTimeout(() => this.connectSTT(), 500);
      }
    };
  }

  private interruptTTS() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = "";
      this.currentAudio = null;
    }
    this.isProcessing = false;
    this.callbacks.onStateChange("listening");
  }

  private async handleUserUtterance(text: string) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    console.log("[KIMI] User:", text);
    this.callbacks.onFinalTranscript({ role: "user", text, timestamp: new Date() });
    this.callbacks.onInterimTranscript("");
    this.callbacks.onStateChange("thinking");

    try {
      const llmResponse = await this.callLLM(text);
      console.log("[KIMI LLM]:", llmResponse);

      this.callbacks.onFinalTranscript({ role: "assistant", text: llmResponse, timestamp: new Date() });
      this.callbacks.onStateChange("speaking");
      await this.speakText(llmResponse);
    } catch (err: any) {
      console.error("[KIMI] Error:", err);
      this.callbacks.onError(err.message || "Pipeline error");
    }

    this.isProcessing = false;
    if (this.isRunning) {
      this.callbacks.onStateChange("listening");
    }
  }

  private async callLLM(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: userMessage });

    const response = await fetch(
      "https://api.fireworks.ai/inference/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FIREWORKS_KEY}`,
        },
        body: JSON.stringify({
          model: FIREWORKS_MODEL,
          messages: this.conversationHistory,
          max_tokens: 80,
          temperature: 0.6,
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`LLM error [${response.status}]: ${errBody}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I didn't catch that.";
    this.conversationHistory.push({ role: "assistant", content: reply });

    // Keep history manageable
    if (this.conversationHistory.length > 16) {
      this.conversationHistory = [
        this.conversationHistory[0],
        ...this.conversationHistory.slice(-8),
      ];
    }

    return reply;
  }

  private async speakText(text: string): Promise<void> {
    const response = await fetch(
      "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          "Content-Type": "text/plain",
        },
        body: text,
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`TTS error [${response.status}]: ${errBody}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    return new Promise<void>((resolve) => {
      const audio = new Audio(url);
      this.currentAudio = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        resolve();
      };

      audio.onerror = () => {
        URL.revokeObjectURL(url);
        this.currentAudio = null;
        resolve(); // Don't throw, just continue
      };

      audio.play().catch(() => {
        this.currentAudio = null;
        resolve();
      });
    });
  }

  stop() {
    this.isRunning = false;

    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    if (this.utteranceTimer) clearTimeout(this.utteranceTimer);

    this.interruptTTS();

    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.socket.close();
      this.socket = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.callbacks.onStateChange("idle");
    this.callbacks.onAudioLevel(0);
    this.callbacks.onWaveformData([]);
    console.log("[KIMI] Stopped");
  }
}
