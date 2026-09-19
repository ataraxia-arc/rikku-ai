"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { formatUtcDate } from "@/lib/workspace/presentation";

export type MemoryExplorerRecord = {
  id: string;
  type: "trade" | "market_context" | "decision" | "behavioral" | "pattern" | "rule" | "thesis";
  statement: string;
  classification: string;
  confidence: string;
  status: string;
  createdAt: string | null;
  evidence: Array<{ direction: string; source: string | null; observedAt: string | null }>;
};

const filters = [
  { label: "All", types: null },
  { label: "Trades", types: ["trade"] },
  { label: "Context", types: ["market_context", "decision"] },
  { label: "Behavior", types: ["behavioral"] },
  { label: "Patterns", types: ["pattern"] },
  { label: "Rules", types: ["rule"] },
  { label: "Theses", types: ["thesis"] },
] as const;

function askHref(statement: string) {
  return `/ask?${new URLSearchParams({ prompt: `Use this RIKKU memory as context: ${statement.slice(0, 350)}` })}`;
}

export function MemoryExplorer({ memories }: { memories: MemoryExplorerRecord[] }) {
  const [selectedFilter, setSelectedFilter] = useState("All");
  const activeFilter = filters.find((filter) => filter.label === selectedFilter) ?? filters[0];
  const selectedTypes = activeFilter.types as readonly MemoryExplorerRecord["type"][] | null;
  const visibleMemories = useMemo(
    () => selectedTypes === null ? memories : memories.filter((memory) => selectedTypes.includes(memory.type)),
    [memories, selectedTypes],
  );
  const hasBehavioralMemory = memories.some((memory) => memory.type === "behavioral");

  return (
    <section aria-labelledby="memory-explorer-title">
      <p className="section-kicker">EVIDENCE-LINKED MEMORY</p>
      <h2 id="memory-explorer-title">Memory explorer</h2>
      <p>Each memory is displayed with its stored confidence, status, date, and any recorded evidence source.</p>
      <div className="home-import-actions" role="group" aria-label="Filter memories">
        {filters.map((filter) => <button
          key={filter.label}
          type="button"
          className={filter.label === selectedFilter ? "landing-cta-primary" : "landing-cta-secondary"}
          aria-pressed={filter.label === selectedFilter}
          onClick={() => setSelectedFilter(filter.label)}
        >{filter.label}</button>)}
      </div>
      {!hasBehavioralMemory && <div className="source-note"><span>BEHAVIORAL MEMORY</span><strong>No behavioral memories have been established from the current data.</strong><p>RIKKU does not infer behavioral claims before the evidence is sufficient.</p></div>}
      <div className="insight-table" aria-live="polite">
        {visibleMemories.length === 0 ? (
          <article><div><span>NO MATCHING MEMORY</span><h3>No evidence-linked memories match this filter.</h3><p>Change the filter or ask RIKKU to explain what evidence is available.</p></div><strong>EMPTY</strong></article>
        ) : visibleMemories.map((memory) => {
          const firstEvidence = memory.evidence[0];
          const source = firstEvidence?.source ?? "Source not recorded";
          const evidenceDate = firstEvidence?.observedAt ?? memory.createdAt;
          return <article key={memory.id}>
            <div>
              <span>{memory.type.replace("_", " ")} · {memory.classification} · {memory.status}</span>
              <h3>{memory.statement}</h3>
              <p>Confidence: {memory.confidence} · Source: {source} · Evidence date: {formatUtcDate(evidenceDate)}</p>
              {memory.evidence.length > 1 && <p>{memory.evidence.length} linked evidence records · first direction: {firstEvidence?.direction}</p>}
              <Link className="data-window" href={askHref(memory.statement)}>Ask RIKKU using this memory <ArrowRight size={12} /></Link>
            </div>
            <strong>{memory.confidence.toUpperCase()}</strong>
          </article>;
        })}
      </div>
    </section>
  );
}
