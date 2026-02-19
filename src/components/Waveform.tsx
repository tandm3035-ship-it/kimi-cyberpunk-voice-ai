import { PipelineState } from "@/lib/voice-pipeline";

interface WaveformProps {
  data: number[];
  state: PipelineState;
}

const Waveform = ({ data, state }: WaveformProps) => {
  const barCount = data.length || 64;
  const color =
    state === "thinking"
      ? "hsl(0 100% 55%)"
      : state === "speaking"
      ? "hsl(120 100% 60%)"
      : "hsl(120 100% 50%)";

  return (
    <div className="flex items-center justify-center gap-[2px] h-12">
      {Array.from({ length: barCount }).map((_, i) => {
        const val = data[i] || 0;
        const height = Math.max(2, Math.abs(val) * 48);
        return (
          <div
            key={i}
            className="rounded-full transition-all duration-75"
            style={{
              width: 3,
              height,
              backgroundColor: color,
              opacity: 0.4 + Math.abs(val) * 0.6,
              boxShadow:
                Math.abs(val) > 0.3
                  ? `0 0 4px ${color}`
                  : "none",
            }}
          />
        );
      })}
    </div>
  );
};

export default Waveform;
