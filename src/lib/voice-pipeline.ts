// Voice pipeline: Deepgram STT (WebSocket) → Fireworks LLM → Deepgram TTS

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
}

export class VoicePipeline {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationFrame: number | null = null;
  private conversationHistory: { role: string; content: string }[] = [];
  private callbacks: PipelineCallbacks;
  private isRunning = false;

  constructor(callbacks: PipelineCallbacks) {
    this.callbacks = callbacks;
    this.conversationHistory = [
      {
        role: "system",
        content:
          "You are KIMI, a cutting-edge AI voice assistant. You are concise, helpful, and speak naturally. Keep responses short (1-3 sentences) since this is a voice conversation. Be warm but efficient.",
      },
    ];
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Get microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      // Set up audio level monitoring
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
      this.monitorAudioLevel();

      // Connect to Deepgram STT WebSocket
      this.connectSTT();
    } catch (err: any) {
      console.error("[KIMI] Mic error:", err);
      this.callbacks.onError("Microphone access denied. Please allow mic access.");
      this.stop();
    }
  }

  private monitorAudioLevel() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.analyser || !this.isRunning) return;
      this.analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      this.callbacks.onAudioLevel(avg / 255);
      this.animationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  private connectSTT() {
    console.log("[KIMI STT] Connecting to Deepgram...");

    const url = `wss://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&interim_results=true&utterance_end_ms=1500&vad_events=true&endpointing=300`;

    this.socket = new WebSocket(url, ["token", DEEPGRAM_KEY]);

    this.socket.onopen = () => {
      console.log("[KIMI STT] WebSocket connected");
      this.callbacks.onStateChange("listening");
      this.startRecording();
    };

    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "Results") {
          const transcript = data.channel?.alternatives?.[0]?.transcript;
          if (!transcript) return;

          if (data.is_final) {
            console.log("[KIMI STT] Final:", transcript);
            // Accumulate final transcripts, process on utterance end
          } else {
            this.callbacks.onInterimTranscript(transcript);
          }
        }

        if (data.type === "UtteranceEnd") {
          // Collect all final text from recent results
          console.log("[KIMI STT] Utterance ended");
        }

        // Handle speech_final for immediate processing
        if (data.type === "Results" && data.speech_final && data.channel?.alternatives?.[0]?.transcript) {
          const finalText = data.channel.alternatives[0].transcript.trim();
          if (finalText) {
            this.handleUserUtterance(finalText);
          }
        }
      } catch (err) {
        console.error("[KIMI STT] Parse error:", err);
      }
    };

    this.socket.onerror = (err) => {
      console.error("[KIMI STT] WebSocket error:", err);
      this.callbacks.onError("STT connection error. Check your Deepgram API key.");
    };

    this.socket.onclose = (event) => {
      console.log("[KIMI STT] WebSocket closed:", event.code, event.reason);
      if (this.isRunning) {
        this.callbacks.onError("STT connection closed unexpectedly.");
      }
    };
  }

  private startRecording() {
    if (!this.mediaStream) return;

    // Check for supported MIME types
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/mp4";

    console.log("[KIMI STT] Recording with MIME:", mimeType);

    this.mediaRecorder = new MediaRecorder(this.mediaStream, {
      mimeType,
    });

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(event.data);
      }
    };

    this.mediaRecorder.start(100); // Send chunks every 100ms
    console.log("[KIMI STT] MediaRecorder started");
  }

  private async handleUserUtterance(text: string) {
    console.log("[KIMI] User said:", text);

    // Add to transcript
    this.callbacks.onFinalTranscript({
      role: "user",
      text,
      timestamp: new Date(),
    });

    this.callbacks.onInterimTranscript("");
    this.callbacks.onStateChange("thinking");

    // Pause recording while processing
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.pause();
    }

    try {
      // Step 2: Send to Fireworks LLM
      const llmResponse = await this.callLLM(text);
      console.log("[KIMI LLM] Response:", llmResponse);

      this.callbacks.onFinalTranscript({
        role: "assistant",
        text: llmResponse,
        timestamp: new Date(),
      });

      // Step 3: TTS with Deepgram
      this.callbacks.onStateChange("speaking");
      await this.speakText(llmResponse);

      // Resume listening
      this.callbacks.onStateChange("listening");
      if (this.mediaRecorder?.state === "paused") {
        this.mediaRecorder.resume();
      }
    } catch (err: any) {
      console.error("[KIMI] Pipeline error:", err);
      this.callbacks.onError(err.message || "Pipeline error");
      this.callbacks.onStateChange("listening");
      if (this.mediaRecorder?.state === "paused") {
        this.mediaRecorder.resume();
      }
    }
  }

  private async callLLM(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: userMessage });

    console.log("[KIMI LLM] Calling Fireworks AI...");
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
          max_tokens: 200,
          temperature: 0.6,
          top_p: 1,
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      console.error("[KIMI LLM] Error:", response.status, errBody);
      throw new Error(`LLM error [${response.status}]: ${errBody}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "I'm sorry, I couldn't process that.";

    this.conversationHistory.push({ role: "assistant", content: reply });

    // Keep conversation history manageable
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = [
        this.conversationHistory[0], // system prompt
        ...this.conversationHistory.slice(-10),
      ];
    }

    return reply;
  }

  private async speakText(text: string): Promise<void> {
    console.log("[KIMI TTS] Requesting Deepgram TTS...");

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
      console.error("[KIMI TTS] Error:", response.status, errBody);
      throw new Error(`TTS error [${response.status}]: ${errBody}`);
    }

    console.log("[KIMI TTS] Got audio, playing...");

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        console.log("[KIMI TTS] Playback complete");
        resolve();
      };
      audio.onerror = (e) => {
        URL.revokeObjectURL(audioUrl);
        console.error("[KIMI TTS] Playback error:", e);
        reject(new Error("Audio playback failed"));
      };
      audio.play().catch((err) => {
        console.error("[KIMI TTS] Play() failed:", err);
        reject(err);
      });
    });
  }

  stop() {
    this.isRunning = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.socket.close();
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }

    if (this.audioContext) {
      this.audioContext.close();
    }

    this.callbacks.onStateChange("idle");
    this.callbacks.onAudioLevel(0);
    console.log("[KIMI] Pipeline stopped");
  }
}
