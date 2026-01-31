'use client';

import { useState } from 'react';
import Link from 'next/link';

type DocumentSummary = {
  slug: string;
  title: string;
  tags?: string[];
};

type FolderNode = {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FolderNode[];
  doc?: DocumentSummary;
};

type SidebarProps = {
  tree: FolderNode[];
  currentSlug?: string;
};

function FolderItem({
  node,
  currentSlug,
  depth = 0,
}: {
  node: FolderNode;
  currentSlug?: string;
  depth?: number;
}) {
  const [isOpen, setIsOpen] = useState(depth < 2);
  const isActive = node.type === 'file' && node.path === currentSlug;

  if (node.type === 'folder') {
    return (
      <div>
        <button
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.name} folder`}
          className="flex items-center gap-1.5 w-full px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)] rounded-[var(--radius-sm)] transition-colors text-[var(--text-secondary)]"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span
            className="text-xs opacity-60 transition-transform"
            style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
          >
            ▶
          </span>
          <span className="opacity-60">📁</span>
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <div>
            {node.children.map((child) => (
              <FolderItem
                key={child.path}
                node={child}
                currentSlug={currentSlug}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Link
      href={`/kb/${node.path}`}
      aria-current={isActive ? 'page' : undefined}
      className={`flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] transition-colors ${
        isActive
          ? 'bg-[var(--accent)] text-white'
          : 'hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="opacity-60">📄</span>
      <span className="truncate">{node.doc?.title || node.name}</span>
    </Link>
  );
}

export function Sidebar({ tree, currentSlug }: SidebarProps) {
  const itemCount = countItems(tree);

  return (
    <aside className="w-64 h-full flex flex-col border-r border-[var(--border)] bg-[var(--bg-panel)] shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-[var(--border-subtle)]">
        <Link href="/kb" className="flex items-center gap-2 font-semibold text-[var(--text)]">
          <span>📚</span>
          <span>Knowledge Base</span>
        </Link>
      </div>

      {/* Search */}
      <div className="p-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-input)] rounded-[var(--radius-sm)] text-sm text-[var(--text-muted)]">
          <span>🔍</span>
          <span className="flex-1">Search...</span>
          <kbd className="text-xs opacity-60">⌘K</kbd>
        </div>
      </div>

      {/* File tree */}
      <nav className="flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <div className="text-center py-8 text-[var(--text-muted)] text-sm">
            <div className="text-2xl mb-2 opacity-40">📂</div>
            <div>No documents yet</div>
          </div>
        ) : (
          tree.map((node) => (
            <FolderItem key={node.path} node={node} currentSlug={currentSlug} />
          ))
        )}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
        <div className="flex justify-between">
          <span>{itemCount} documents</span>
          <Link
            href="/"
            className="opacity-60 hover:opacity-100 transition-opacity hover:text-[var(--accent)]"
          >
            ← Dashboard
          </Link>
        </div>
      </div>
    </aside>
  );
}

function countItems(nodes: FolderNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file') {
      count++;
    } else if (node.children) {
      count += countItems(node.children);
    }
  }
  return count;
}
