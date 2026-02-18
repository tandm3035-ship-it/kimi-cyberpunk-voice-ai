import { useState, useCallback, useRef } from "react";
import { VoicePipeline, PipelineState, TranscriptEntry } from "@/lib/voice-pipeline";
import VoiceOrb from "@/components/VoiceOrb";
import Transcript from "@/components/Transcript";
import Waveform from "@/components/Waveform";
import { Mic, MicOff, PhoneOff } from "lucide-react";

const Index = () => {
  const [state, setState] = useState<PipelineState>("idle");
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interimText, setInterimText] = useState("");
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [error, setError] = useState("");
  const pipelineRef = useRef<VoicePipeline | null>(null);

  const handleStart = useCallback(() => {
    setError("");
    setTranscript([]);
    const pipeline = new VoicePipeline({
      onStateChange: setState,
      onInterimTranscript: setInterimText,
      onFinalTranscript: (entry) => setTranscript((prev) => [...prev, entry]),
      onError: (err) => setError(err),
      onAudioLevel: setAudioLevel,
      onWaveformData: setWaveformData,
    });
    pipelineRef.current = pipeline;
    pipeline.start();
  }, []);

  const handleStop = useCallback(() => {
    pipelineRef.current?.stop();
    pipelineRef.current = null;
  }, []);

  const isActive = state !== "idle";

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background cyber-grid scanlines overflow-hidden">
      {/* Header */}
      <div className="absolute top-8 left-0 right-0 text-center">
        <h1 className="font-display text-4xl font-bold tracking-[0.2em] text-primary neon-text-strong">
          KIMI
        </h1>
        <p className="mt-2 font-mono text-xs tracking-[0.15em] text-muted-foreground uppercase">
          Voice AI Assistant • Neural Link Active
        </p>
      </div>

      {/* Voice Orb */}
      <div className="mb-8">
        <VoiceOrb state={state} audioLevel={audioLevel} />
      </div>

      {/* Live Waveform */}
      {isActive && (
        <div className="mb-8 w-80">
          <Waveform data={waveformData} state={state} />
        </div>
      )}

      {/* Start/Stop Button */}
      {!isActive ? (
        <button
          onClick={handleStart}
          className="relative z-10 flex items-center gap-3 rounded-full px-14 py-6 font-display text-xl font-bold tracking-[0.15em] uppercase bg-primary/20 border-2 border-primary text-primary hover:bg-primary/30 neon-border transition-all duration-300"
          style={{
            boxShadow:
              "0 0 20px hsl(120 100% 50% / 0.5), 0 0 40px hsl(120 100% 50% / 0.3), 0 0 80px hsl(120 100% 50% / 0.15)",
          }}
        >
          <Mic className="h-7 w-7" />
          START CALL
        </button>
      ) : (
        <button
          onClick={handleStop}
          className="relative z-10 flex items-center gap-3 rounded-full px-14 py-6 font-display text-xl font-bold tracking-[0.15em] uppercase bg-destructive/30 border-4 border-destructive text-destructive hover:bg-destructive/50 transition-all duration-200 animate-pulse"
          style={{
            boxShadow:
              "0 0 25px hsl(0 80% 50% / 0.6), 0 0 50px hsl(0 80% 50% / 0.3), 0 0 100px hsl(0 80% 50% / 0.15)",
          }}
        >
          <PhoneOff className="h-7 w-7" />
          END CALL
        </button>
      )}

      {/* Error display */}
      {error && (
        <div className="mt-4 rounded border border-destructive/50 bg-destructive/10 px-4 py-2 font-mono text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Transcript panel */}
      <div className="absolute bottom-0 left-0 right-0 h-48 border-t border-border/30 bg-background/80 backdrop-blur-sm p-4">
        <Transcript entries={transcript} interimText={interimText} />
      </div>

      {/* Corner decorations */}
      <div className="absolute top-4 left-4 h-8 w-8 border-l-2 border-t-2 border-primary/30" />
      <div className="absolute top-4 right-4 h-8 w-8 border-r-2 border-t-2 border-primary/30" />
      <div className="absolute bottom-52 left-4 h-8 w-8 border-l-2 border-b-2 border-primary/30" />
      <div className="absolute bottom-52 right-4 h-8 w-8 border-r-2 border-b-2 border-primary/30" />
    </div>
  );
};

export default Index;
