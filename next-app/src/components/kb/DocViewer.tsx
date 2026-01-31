'use client';

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

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main content */}
      <article className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-12">
          {/* Meta */}
          <header className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight mb-4">{title}</h1>

            <div className="flex items-center gap-4 text-sm text-[var(--text-dim)]">
              {createdStr && <span>Created {createdStr}</span>}
              {updatedStr && updatedStr !== createdStr && (
                <span>Updated {updatedStr}</span>
              )}
            </div>

            {tags && tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 text-xs font-medium rounded-full bg-[var(--accent-muted)] text-[var(--accent)]"
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
        <aside className="w-72 h-full border-l border-[var(--border)] bg-[var(--bg-panel)] overflow-y-auto shrink-0">
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
                        className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-secondary)] hover:text-[var(--text)]"
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
      )}
    </div>
  );
}
