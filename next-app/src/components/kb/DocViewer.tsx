'use client';

import { useState } from 'react';
import Link from 'next/link';

type Backlink = {
  slug: string;
  title: string;
};

type DocMeta = {
  type?: string;
  status?: string;
  source?: string;
  confidence?: string;
};

type DocViewerProps = {
  title: string;
  tags?: string[];
  html: string;
  created?: string;
  updated?: string;
  backlinks?: Backlink[];
  meta?: DocMeta;
};

function formatDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  try {
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return date;
  }
}

function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function DocViewer({
  title,
  tags,
  html,
  created,
  updated,
  backlinks = [],
  meta,
}: DocViewerProps) {
  const createdStr = formatDate(created);
  const updatedStr = formatDate(updated);
  const hasBacklinks = backlinks.length > 0;
  const hasProperties = meta?.type || meta?.status || meta?.source || meta?.confidence;
  const [mobileMetaOpen, setMobileMetaOpen] = useState(false);

  return (
    <div className="flex flex-1 overflow-hidden md:flex-row flex-col">
      {/* Main content */}
      <article className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 md:px-8 py-6 md:py-12">
          {/* Meta */}
          <header className="mb-6 md:mb-8">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3 md:mb-4">{title}</h1>

            <div className="flex flex-wrap items-center gap-2 md:gap-4 text-sm text-[var(--text-dim)]">
              {createdStr && <span>Created {createdStr}</span>}
              {updatedStr && updatedStr !== createdStr && (
                <span>Updated {updatedStr}</span>
              )}
            </div>

            {tags && tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3 md:mt-4">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-[var(--accent-muted)] text-[var(--accent)]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* Content */}
          <div
            className="prose prose-invert prose-headings:text-[var(--text)] prose-p:text-[var(--text-secondary)] prose-a:text-[var(--accent)] prose-a:no-underline hover:prose-a:underline prose-strong:text-[var(--text)] prose-code:text-[var(--accent)] prose-code:bg-[var(--bg-input)] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[var(--bg-input)] prose-pre:border prose-pre:border-[var(--border)] max-w-none"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </article>

      {/* Right panel - properties & backlinks */}
      {(hasBacklinks || hasProperties) && (
        <>
          {/* Mobile: Collapsible panel at bottom */}
          <aside className="md:hidden border-t border-[var(--border)] bg-[var(--bg-panel)] shrink-0">
            <button
              type="button"
              onClick={() => setMobileMetaOpen(!mobileMetaOpen)}
              className="w-full flex items-center justify-between px-4 py-3 min-h-[48px] text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              aria-expanded={mobileMetaOpen}
            >
              <span className="flex items-center gap-2">
                <span className="opacity-60">ℹ️</span>
                <span>
                  {hasProperties && hasBacklinks
                    ? `Properties & ${backlinks.length} Backlink${backlinks.length !== 1 ? 's' : ''}`
                    : hasBacklinks
                    ? `${backlinks.length} Backlink${backlinks.length !== 1 ? 's' : ''}`
                    : 'Properties'}
                </span>
              </span>
              <span
                className="text-xs transition-transform duration-200"
                style={{ transform: mobileMetaOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                ▼
              </span>
            </button>
            
            {mobileMetaOpen && (
              <div className="px-4 pb-4 space-y-6 border-t border-[var(--border-subtle)]">
                {/* Properties */}
                {hasProperties && (
                  <section className="pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                      Properties
                    </h3>
                    <dl className="grid grid-cols-2 gap-2 text-sm">
                      {meta?.type && (
                        <div className="bg-[var(--bg-input)] rounded-[var(--radius-sm)] px-3 py-2">
                          <dt className="text-[var(--text-dim)] text-xs">Type</dt>
                          <dd className="capitalize text-[var(--text-secondary)]">
                            {meta.type}
                          </dd>
                        </div>
                      )}
                      {meta?.status && (
                        <div className="bg-[var(--bg-input)] rounded-[var(--radius-sm)] px-3 py-2">
                          <dt className="text-[var(--text-dim)] text-xs">Status</dt>
                          <dd className="capitalize text-[var(--text-secondary)]">
                            {meta.status}
                          </dd>
                        </div>
                      )}
                      {meta?.confidence && (
                        <div className="bg-[var(--bg-input)] rounded-[var(--radius-sm)] px-3 py-2">
                          <dt className="text-[var(--text-dim)] text-xs">Confidence</dt>
                          <dd className="capitalize text-[var(--text-secondary)]">
                            {meta.confidence}
                          </dd>
                        </div>
                      )}
                      {meta?.source && (
                        <div className="col-span-2 bg-[var(--bg-input)] rounded-[var(--radius-sm)] px-3 py-2">
                          <dt className="text-[var(--text-dim)] text-xs mb-1">Source</dt>
                          <dd className="text-xs break-all">
                            {isValidUrl(meta.source) ? (
                              <a
                                href={meta.source}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[var(--accent)] hover:underline"
                              >
                                {meta.source}
                              </a>
                            ) : (
                              <span className="text-[var(--text-secondary)]">
                                {meta.source}
                              </span>
                            )}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </section>
                )}

                {/* Backlinks */}
                {hasBacklinks && (
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                      Backlinks ({backlinks.length})
                    </h3>
                    <ul className="space-y-1">
                      {backlinks.map((link) => (
                        <li key={link.slug}>
                          <Link
                            href={`/kb/${link.slug}`}
                            className="flex items-center gap-2 px-3 py-3 min-h-[48px] text-sm rounded-[var(--radius-sm)] bg-[var(--bg-input)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-active)] transition-colors text-[var(--text-secondary)] hover:text-[var(--text)]"
                          >
                            <span className="opacity-60">📄</span>
                            <span className="truncate flex-1">{link.title}</span>
                            <span className="text-xs opacity-40">→</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </aside>

          {/* Desktop: Side panel */}
          <aside className="hidden md:block w-72 h-full border-l border-[var(--border)] bg-[var(--bg-panel)] overflow-y-auto shrink-0">
            <div className="p-4 space-y-6">
              {/* Properties */}
              {hasProperties && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                    Properties
                  </h3>
                  <dl className="space-y-2 text-sm">
                    {meta?.type && (
                      <div className="flex justify-between">
                        <dt className="text-[var(--text-dim)]">Type</dt>
                        <dd className="capitalize text-[var(--text-secondary)]">
                          {meta.type}
                        </dd>
                      </div>
                    )}
                    {meta?.status && (
                      <div className="flex justify-between">
                        <dt className="text-[var(--text-dim)]">Status</dt>
                        <dd className="capitalize text-[var(--text-secondary)]">
                          {meta.status}
                        </dd>
                      </div>
                    )}
                    {meta?.confidence && (
                      <div className="flex justify-between">
                        <dt className="text-[var(--text-dim)]">Confidence</dt>
                        <dd className="capitalize text-[var(--text-secondary)]">
                          {meta.confidence}
                        </dd>
                      </div>
                    )}
                    {meta?.source && (
                      <div>
                        <dt className="text-[var(--text-dim)] mb-1">Source</dt>
                        <dd className="text-xs break-all">
                          {isValidUrl(meta.source) ? (
                            <a
                              href={meta.source}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[var(--accent)] hover:underline"
                            >
                              {meta.source}
                            </a>
                          ) : (
                            <span className="text-[var(--text-secondary)]">
                              {meta.source}
                            </span>
                          )}
                        </dd>
                      </div>
                    )}
                  </dl>
                </section>
              )}

              {/* Backlinks */}
              {hasBacklinks && (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
                    Backlinks ({backlinks.length})
                  </h3>
                  <ul className="space-y-1">
                    {backlinks.map((link) => (
                      <li key={link.slug}>
                        <Link
                          href={`/kb/${link.slug}`}
                          className="flex items-center gap-2 px-2 py-2 min-h-[44px] text-sm rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-secondary)] hover:text-[var(--text)]"
                        >
                          <span className="opacity-60">📄</span>
                          <span className="truncate">{link.title}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
