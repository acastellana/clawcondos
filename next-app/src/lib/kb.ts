import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

// Types
export type DocumentMeta = {
  title: string;
  tags?: string[];
  created?: string;
  updated?: string;
  type?: 'concept' | 'person' | 'project' | 'journal' | 'note' | 'brief';
  status?: string;
  source?: string;
  confidence?: 'high' | 'medium' | 'low' | 'speculative';
  [key: string]: unknown;
};

export type Document = {
  slug: string;
  filePath: string;
  meta: DocumentMeta;
  content: string;
  html: string;
  links: string[];
  backlinks: string[];
};

export type DocumentSummary = {
  slug: string;
  title: string;
  tags?: string[];
  type?: string;
};

export type FolderNode = {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FolderNode[];
  doc?: DocumentSummary;
};

// Constants
const KB_PATH = path.join(process.cwd(), 'kb');
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g;

/**
 * Extract wiki-links from markdown content
 */
export function extractLinks(content: string): string[] {
  const matches = content.matchAll(WIKI_LINK_REGEX);
  const links = Array.from(matches, match => match[1]);
  return [...new Set(links)];
}

/**
 * Resolve a wiki-link to a slug
 * [[concepts/Architecture]] -> concepts/Architecture
 * [[README]] -> README
 */
export function resolveWikiLink(link: string, currentSlug: string): string {
  if (link.includes('/')) {
    return link.replace(/\.md$/, '');
  }
  
  const currentDir = path.dirname(currentSlug);
  if (currentDir && currentDir !== '.') {
    const relPath = path.join(currentDir, link);
    const absPath = path.join(KB_PATH, relPath + '.md');
    if (fs.existsSync(absPath)) {
      return relPath;
    }
  }
  
  return link;
}

/**
 * Convert markdown to HTML
 */
export async function renderMarkdown(content: string): Promise<string> {
  const result = await remark()
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(content);
  
  return String(result);
}

/**
 * Convert wiki-links in HTML to anchor tags
 */
export function linkifyWikiLinks(html: string, currentSlug: string): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_, link) => {
    if (link.endsWith('/')) {
      return `<span class="wiki-link broken">${link}</span>`;
    }
    
    const slug = resolveWikiLink(link, currentSlug);
    const displayText = link.split('/').pop() || link;
    
    const targetPath = path.join(KB_PATH, slug + '.md');
    const exists = fs.existsSync(targetPath);
    
    if (!exists) {
      return `<span class="wiki-link broken">${displayText}</span>`;
    }
    
    return `<a href="/kb/${slug}" class="wiki-link">${displayText}</a>`;
  });
}

/**
 * Parse a single markdown document
 */
export async function parseDocument(filePath: string): Promise<Document> {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(KB_PATH, filePath);
  const relativePath = path.relative(KB_PATH, fullPath);
  const slug = relativePath.replace(/\.md$/, '');
  
  const fileContent = fs.readFileSync(fullPath, 'utf-8');
  const { data, content } = matter(fileContent);
  
  const links = extractLinks(content);
  let html = await renderMarkdown(content);
  html = linkifyWikiLinks(html, slug);
  
  const meta: DocumentMeta = {
    title: data.title || slug.split('/').pop() || slug,
    ...data,
  };
  
  return {
    slug,
    filePath: relativePath,
    meta,
    content,
    html,
    links,
    backlinks: [],
  };
}

/**
 * Recursively find all markdown files
 */
function findMarkdownFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findMarkdownFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * Get all documents from the knowledge base
 */
export async function getAllDocuments(): Promise<Document[]> {
  const files = findMarkdownFiles(KB_PATH);
  if (files.length === 0) return [];
  
  const docs = await Promise.all(files.map(f => parseDocument(f)));
  return computeBacklinks(docs);
}

/**
 * Get document summaries (lighter weight for sidebar)
 */
export async function getDocumentSummaries(): Promise<DocumentSummary[]> {
  const docs = await getAllDocuments();
  return docs.map(doc => ({
    slug: doc.slug,
    title: doc.meta.title,
    tags: doc.meta.tags,
    type: doc.meta.type,
  }));
}

/**
 * Compute backlinks for all documents
 */
function computeBacklinks(docs: Document[]): Document[] {
  const slugMap = new Map<string, Document>();
  for (const doc of docs) {
    slugMap.set(doc.slug, doc);
  }
  
  for (const doc of docs) {
    const backlinks: string[] = [];
    
    for (const other of docs) {
      if (other.slug === doc.slug) continue;
      
      for (const link of other.links) {
        const resolvedLink = resolveWikiLink(link, other.slug);
        if (resolvedLink === doc.slug || resolvedLink === doc.meta.title) {
          backlinks.push(other.slug);
          break;
        }
      }
    }
    
    doc.backlinks = [...new Set(backlinks)];
  }
  
  return docs;
}

/**
 * Get a single document by slug
 */
export async function getDocument(slug: string): Promise<Document | null> {
  const filePath = path.join(KB_PATH, slug + '.md');
  
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  const allDocs = await getAllDocuments();
  return allDocs.find(d => d.slug === slug) || null;
}

/**
 * Search documents by query
 */
export async function searchDocuments(query: string): Promise<DocumentSummary[]> {
  const docs = await getAllDocuments();
  const q = query.toLowerCase();
  
  return docs
    .filter(doc => {
      const title = doc.meta.title.toLowerCase();
      const content = doc.content.toLowerCase();
      const tags = (doc.meta.tags || []).join(' ').toLowerCase();
      
      return title.includes(q) || content.includes(q) || tags.includes(q);
    })
    .map(doc => ({
      slug: doc.slug,
      title: doc.meta.title,
      tags: doc.meta.tags,
      type: doc.meta.type,
    }));
}

/**
 * Build folder tree structure for sidebar
 */
export async function getFolderTree(): Promise<FolderNode[]> {
  const docs = await getDocumentSummaries();
  const root: FolderNode[] = [];
  
  docs.sort((a, b) => a.slug.localeCompare(b.slug));
  
  for (const doc of docs) {
    const parts = doc.slug.split('/');
    let current = root;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const pathSoFar = parts.slice(0, i + 1).join('/');
      
      let node = current.find(n => n.name === part);
      
      if (!node) {
        node = {
          name: part,
          path: pathSoFar,
          type: isLast ? 'file' : 'folder',
          children: isLast ? undefined : [],
          doc: isLast ? doc : undefined,
        };
        current.push(node);
      }
      
      if (!isLast && node.children) {
        current = node.children;
      }
    }
  }
  
  return root;
}

/**
 * Check if KB directory exists
 */
export function kbExists(): boolean {
  return fs.existsSync(KB_PATH);
}

/**
 * Get KB path
 */
export function getKbPath(): string {
  return KB_PATH;
}
