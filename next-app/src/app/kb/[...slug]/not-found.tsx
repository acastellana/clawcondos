import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="text-center">
        <div className="text-6xl mb-4 opacity-40">📄</div>
        <h1 className="text-2xl font-bold mb-2">Document not found</h1>
        <p className="text-[var(--text-dim)] mb-6">
          The document you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link
          href="/kb"
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-white rounded-[var(--radius-md)] hover:bg-[var(--accent-hover)] transition-colors"
        >
          ← Back to Knowledge Base
        </Link>
      </div>
    </div>
  );
}
