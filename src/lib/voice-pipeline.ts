// Voice pipeline: LiveKit-powered ultra-low-latency voice AI
import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrackPublication, type RemoteTrack } from "livekit-client";

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
  private room: Room | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animationFrame: number | null = null;
  private callbacks: PipelineCallbacks;
  private isRunning = false;

  constructor(callbacks: PipelineCallbacks) {
    this.callbacks = callbacks;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const res = await fetch(`${supabaseUrl}/functions/v1/livekit-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${supabaseKey}`,
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Token error: ${errText}`);
      }

      const { token, url } = await res.json();

      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.setupRoomEvents();

      await this.room.connect(url, token);
      await this.room.localParticipant.setMicrophoneEnabled(true);

      // Set up audio monitoring after mic is enabled
      setTimeout(() => this.setupAudioMonitoring(), 500);

      this.callbacks.onStateChange("listening");
      console.log("[KIMI] Connected to LiveKit room");
    } catch (err: any) {
      console.error("[KIMI] Start error:", err);
      this.callbacks.onError(err?.message || "Failed to connect");
      this.stop();
    }
  }

  private setupRoomEvents() {
    if (!this.room) return;

    this.room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.id = `lk-audio-${participant.identity}`;
          document.body.appendChild(el);
          this.callbacks.onStateChange("speaking");
        }
      }
    );

    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
    });

    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (!this.isRunning) return;
      const agentSpeaking = speakers.some((s) => !s.isLocal);
      if (agentSpeaking) {
        this.callbacks.onStateChange("speaking");
      } else {
        this.callbacks.onStateChange("listening");
      }
    });

    this.room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (!participant || participant.isLocal) return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.text) {
          this.callbacks.onFinalTranscript({
            role: "assistant",
            text: msg.text,
            timestamp: new Date(),
          });
        }
      } catch {
        // not JSON data
      }
    });

    // LiveKit Agents transcription events
    this.room.on(RoomEvent.TranscriptionReceived as any, (segments: any[], participant: any) => {
      for (const seg of segments) {
        if (seg.final) {
          this.callbacks.onInterimTranscript("");
          this.callbacks.onFinalTranscript({
            role: participant?.isLocal ? "user" : "assistant",
            text: seg.text,
            timestamp: new Date(),
          });
        } else {
          this.callbacks.onInterimTranscript(seg.text);
        }
      }
    });

    this.room.on(RoomEvent.Disconnected, () => {
      if (this.isRunning) {
        this.callbacks.onError("Disconnected from room");
        this.stop();
      }
    });

    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log("[KIMI] Agent joined:", participant.identity);
    });
  }

  private setupAudioMonitoring() {
    const pub = this.room?.localParticipant?.getTrackPublication(Track.Source.Microphone);
    const mediaTrack = pub?.track?.mediaStreamTrack;

    if (mediaTrack) {
      this.audioContext = new AudioContext();
      const stream = new MediaStream([mediaTrack]);
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
      this.monitorAudio();
      return;
    }

    // Fallback: use LiveKit's built-in audio levels
    this.monitorParticipantLevels();
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

  private monitorParticipantLevels() {
    const tick = () => {
      if (!this.isRunning || !this.room) return;
      const level = this.room.localParticipant?.audioLevel || 0;
      this.callbacks.onAudioLevel(level);

      const waveform: number[] = [];
      for (let i = 0; i < 64; i++) {
        const noise = (Math.random() - 0.5) * 0.1;
        waveform.push(level * Math.sin(i * 0.3 + Date.now() * 0.01) + noise * level);
      }
      this.callbacks.onWaveformData(waveform);

      this.animationFrame = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.isRunning = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    this.analyser = null;

    // Clean up attached audio elements
    document.querySelectorAll("[id^='lk-audio-']").forEach((el) => el.remove());

    this.callbacks.onInterimTranscript("");
    this.callbacks.onStateChange("idle");
    this.callbacks.onAudioLevel(0);
    this.callbacks.onWaveformData([]);
    console.log("[KIMI] Stopped");
  }
}
