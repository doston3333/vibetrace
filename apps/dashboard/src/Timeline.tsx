import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';

import { TIMELINE_LANES, formatClock, type TimelineItem } from './forensics.js';

interface TimelineProps {
  readonly items: readonly TimelineItem[];
  readonly selectedId?: string;
  readonly onSelect: (id: string) => void;
}

const LANE_LABELS = {
  conversation: 'Conversation',
  context: 'Context',
  tools: 'Tools / terminal',
  code: 'Code',
  verification: 'Verification',
} as const;

const TONE_LABELS = {
  neutral: 'Fact',
  success: 'Success',
  failure: 'Failure',
  gap: 'Capture gap',
} as const;

/** A fixed-row virtualized evidence timeline with roving keyboard selection. */
export function Timeline({ items, selectedId, onSelect }: TimelineProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const selectedIndex = useMemo(
    () =>
      Math.max(
        0,
        items.findIndex((item) => item.id === selectedId),
      ),
    [items, selectedId],
  );
  // React Compiler deliberately skips this hook; TanStack Virtual owns its mutable measurements.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => items[index]?.id ?? index,
  });

  const move = (index: number) => {
    const bounded = Math.max(0, Math.min(items.length - 1, index));
    const item = items[bounded];
    if (!item) return;
    onSelect(item.id);
    virtualizer.scrollToIndex(bounded, { align: 'auto' });
  };

  if (items.length === 0)
    return (
      <div className="timeline-empty" role="status">
        <span aria-hidden="true">No events</span>
        <strong>No evidence matches these filters.</strong>
        <p>Clear a filter to return to the full observable timeline.</p>
      </div>
    );

  return (
    <section className="timeline-frame" aria-labelledby="timeline-heading">
      <div className="timeline-heading-row">
        <div>
          <p className="eyebrow">Unified chronology</p>
          <h2 id="timeline-heading">Evidence timeline</h2>
        </div>
        <span className="timeline-count">
          {items.length.toLocaleString()} observable events
        </span>
      </div>
      <div className="timeline-x-scroll">
        <div className="lane-header" aria-hidden="true">
          <span>Time</span>
          {TIMELINE_LANES.map((lane) => (
            <span key={lane}>{LANE_LABELS[lane]}</span>
          ))}
        </div>
        <div
          className="timeline-scroll"
          ref={scroll}
          role="listbox"
          tabIndex={0}
          aria-label="Session evidence. Use arrow keys to move between events."
          aria-activedescendant={
            selectedId ? `timeline-${selectedId}` : undefined
          }
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(selectedIndex + 1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(selectedIndex - 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              move(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              move(items.length - 1);
            }
          }}
        >
          <div
            className="timeline-virtual-space"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              if (!item) return null;
              return (
                <div
                  className="timeline-row"
                  data-selected={item.id === selectedId}
                  key={item.id}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <time dateTime={item.timestamp}>
                    {formatClock(item.timestamp)}
                  </time>
                  <div
                    className={`lane-cell lane-${item.lane}`}
                    data-lane={item.lane}
                  >
                    <button
                      id={`timeline-${item.id}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={item.id === selectedId}
                      aria-label={`${TONE_LABELS[item.tone]} · ${LANE_LABELS[item.lane]} · event ${item.sequence}: ${item.title}`}
                      className="event-chip"
                      data-tone={item.tone}
                      onClick={() => onSelect(item.id)}
                    >
                      <span className="event-meta">
                        <span className="event-sequence">#{item.sequence}</span>
                        <span className="event-lane">
                          {LANE_LABELS[item.lane]}
                        </span>
                        <span className="event-state">
                          {TONE_LABELS[item.tone]}
                        </span>
                      </span>
                      <strong>{item.title}</strong>
                      <small>{item.detail || item.type}</small>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
