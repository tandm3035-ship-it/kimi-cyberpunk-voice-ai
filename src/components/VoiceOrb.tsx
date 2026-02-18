import { PipelineState } from "@/lib/voice-pipeline";

interface VoiceOrbProps {
  state: PipelineState;
  audioLevel: number;
}

const VoiceOrb = ({ state, audioLevel }: VoiceOrbProps) => {
  const scale = state === "listening" ? 1 + audioLevel * 0.5 : 1;
  const orbClass =
    state === "listening"
      ? "orb-listening"
      : state === "speaking"
      ? "orb-speaking"
      : state === "thinking"
      ? ""
      : "orb-idle";

  return (
    <div className="relative flex items-center justify-center">
      {/* Ripple rings */}
      {(state === "listening" || state === "speaking") && (
        <>
          <div
            className="absolute rounded-full border border-primary/30"
            style={{
              width: 220,
              height: 220,
              animation: "ripple 2s ease-out infinite",
            }}
          />
          <div
            className="absolute rounded-full border border-primary/20"
            style={{
              width: 220,
              height: 220,
              animation: "ripple 2s ease-out infinite 0.5s",
            }}
          />
          <div
            className="absolute rounded-full border border-primary/10"
            style={{
              width: 220,
              height: 220,
              animation: "ripple 2s ease-out infinite 1s",
            }}
          />
        </>
      )}

      {/* Outer glow */}
      <div
        className="absolute rounded-full"
        style={{
          width: 200,
          height: 200,
          background: `radial-gradient(circle, hsl(120 100% 50% / ${
            state === "idle" ? 0.05 : state === "thinking" ? 0.15 : 0.2 + audioLevel * 0.3
          }) 0%, transparent 70%)`,
          transform: `scale(${scale * 1.2})`,
          transition: "transform 0.1s ease-out",
        }}
      />

      {/* Main orb */}
      <div
        className={`relative rounded-full ${orbClass}`}
        style={{
          width: 160,
          height: 160,
          background: `radial-gradient(circle at 35% 35%, 
            hsl(120 100% 60% / ${state === "idle" ? 0.15 : 0.3 + audioLevel * 0.4}) 0%, 
            hsl(120 100% 50% / ${state === "idle" ? 0.08 : 0.15 + audioLevel * 0.2}) 40%, 
            hsl(120 100% 40% / 0.05) 70%, 
            transparent 100%)`,
          border: `2px solid hsl(120 100% 50% / ${state === "idle" ? 0.2 : 0.5 + audioLevel * 0.5})`,
          boxShadow:
            state !== "idle"
              ? `0 0 ${20 + audioLevel * 40}px hsl(120 100% 50% / ${0.3 + audioLevel * 0.4}), 
                 inset 0 0 ${10 + audioLevel * 20}px hsl(120 100% 50% / ${0.1 + audioLevel * 0.2})`
              : "0 0 10px hsl(120 100% 50% / 0.1)",
          transform: `scale(${scale})`,
          transition: "transform 0.1s ease-out, box-shadow 0.1s ease-out",
        }}
      >
        {/* Inner core */}
        <div
          className="absolute inset-[30%] rounded-full"
          style={{
            background: `radial-gradient(circle, 
              hsl(120 100% 70% / ${state === "idle" ? 0.3 : 0.5 + audioLevel * 0.5}) 0%, 
              hsl(120 100% 50% / ${state === "idle" ? 0.1 : 0.2}) 100%)`,
          }}
        />
      </div>

      {/* State label */}
      <div className="absolute -bottom-10 font-display text-xs tracking-[0.3em] uppercase text-primary/60">
        {state === "idle"
          ? "STANDBY"
          : state === "listening"
          ? "LISTENING"
          : state === "thinking"
          ? "PROCESSING"
          : "SPEAKING"}
      </div>
    </div>
  );
};

export default VoiceOrb;
