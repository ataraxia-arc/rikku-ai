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

function askHref(id: string) {
  return `/ask?${new URLSearchParams({ context: `memory:${id}` })}`;
}

export function MemoryExplorer({ memories }: { memories: MemoryExplorerRecord[] }) {
  const [selectedFilter, setSelectedFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "confidence">("newest");
  const [openMemory, setOpenMemory] = useState<string | null>(null);
  const activeFilter = filters.find((filter) => filter.label === selectedFilter) ?? filters[0];
  const selectedTypes = activeFilter.types as readonly MemoryExplorerRecord["type"][] | null;
  const visibleMemories = useMemo(() => {
    const ranks: Record<string, number> = { very_high: 4, high: 3, moderate: 2, low: 1, not_assessable: 0 };
    const filtered = memories.filter((memory) => (selectedTypes === null || selectedTypes.includes(memory.type))
      && (!query.trim() || `${memory.statement} ${memory.classification} ${memory.type}`.toLowerCase().includes(query.trim().toLowerCase())));
    return [...filtered].sort((a, b) => sort === "confidence"
      ? (ranks[b.confidence] ?? 0) - (ranks[a.confidence] ?? 0)
      : sort === "oldest"
        ? Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? "")
        : Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  }, [memories, query, selectedTypes, sort]);
  const hasBehavioralMemory = memories.some((memory) => memory.type === "behavioral");

  return (
    <section aria-labelledby="memory-explorer-title">
      <p className="section-kicker">EVIDENCE-LINKED MEMORY</p>
      <h2 id="memory-explorer-title">Memory explorer</h2>
      <p>Each memory is displayed with its stored confidence, status, date, and any recorded evidence source.</p>
      <div className="composer-controls" aria-label="Search and sort memories">
        <label><span className="sr-only">Search memories</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memories" /></label>
        <label><span className="sr-only">Sort memories</span><select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="confidence">Confidence</option></select></label>
      </div>
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
              <p>Confidence: {memory.confidence} · Evidence: {memory.evidence.length} · Created: {formatUtcDate(memory.createdAt)}</p>
              {openMemory === memory.id ? <p>Source: {source} · Evidence date: {formatUtcDate(evidenceDate)}{memory.evidence.length > 1 ? ` · ${memory.evidence.length} linked evidence records` : ""}</p> : null}
              <button type="button" className="data-window" aria-expanded={openMemory === memory.id} onClick={() => setOpenMemory(openMemory === memory.id ? null : memory.id)}>{openMemory === memory.id ? "Close memory" : "Open memory"}</button>
              <Link className="data-window" href={askHref(memory.id)}>Ask RIKKU using this memory <ArrowRight size={12} /></Link>
            </div>
            <strong>{memory.confidence.toUpperCase()}</strong>
          </article>;
        })}
      </div>
    </section>
  );
}
