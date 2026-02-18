import { TranscriptEntry } from "@/lib/voice-pipeline";
import { useEffect, useRef } from "react";

interface TranscriptProps {
  entries: TranscriptEntry[];
  interimText: string;
}

const Transcript = ({ entries, interimText }: TranscriptProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, interimText]);

  if (entries.length === 0 && !interimText) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground font-mono text-sm">
        <span className="opacity-50">// transcript will appear here</span>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto space-y-3 pr-2 scrollbar-thin">
      {entries.map((entry, i) => (
        <div key={i} className="font-mono text-sm">
          <span className={entry.role === "user" ? "text-muted-foreground" : "text-primary neon-text"}>
            {entry.role === "user" ? "> YOU: " : "> KIMI: "}
          </span>
          <span className={entry.role === "user" ? "text-foreground/70" : "text-primary/90"}>
            {entry.text}
          </span>
        </div>
      ))}
      {interimText && (
        <div className="font-mono text-sm animate-pulse">
          <span className="text-muted-foreground">{"> YOU: "}</span>
          <span className="text-foreground/40 italic">{interimText}...</span>
        </div>
      )}
    </div>
  );
};

export default Transcript;
