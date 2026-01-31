'use client';

/**
 * Sidebar Component
 * Main navigation sidebar with connection status
 */

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useGateway } from '@/hooks/use-gateway';

type NavItemProps = {
  href: string;
  icon: string;
  label: string;
  isActive?: boolean;
};

function NavItem({ href, icon, label, isActive }: NavItemProps): React.ReactElement {
  return (
    <Link
      href={href}
      className={`
        flex items-center gap-3 px-4 py-2.5 mx-0.5 
        rounded-[var(--radius-md)] transition-all border-l-2
        ${isActive 
          ? 'bg-[var(--bg-active)] text-[var(--text)] border-[var(--accent)]' 
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] border-transparent hover:border-[var(--border-hover)]'
        }
      `}
    >
      <span className={`
        w-8 h-8 flex items-center justify-center 
        border rounded-[var(--radius-md)] text-base
        ${isActive 
          ? 'bg-[var(--accent-muted)] border-[var(--accent)]' 
          : 'bg-[var(--bg)] border-[var(--border-subtle)]'
        }
      `}>
        {icon}
      </span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
}

function NavSection({ 
  title, 
  children 
}: { 
  title: string; 
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-6">
      <div className="px-4 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-dim)]">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

export function Sidebar(): React.ReactElement {
  const pathname = usePathname();
  const { status, isConnected } = useGateway();

  const getStatusColor = (): string => {
    switch (status) {
      case 'connected': return 'bg-[var(--green)]';
      case 'connecting': return 'bg-[var(--yellow)] animate-pulse';
      case 'error': return 'bg-[var(--red)]';
      default: return 'bg-[var(--text-muted)]';
    }
  };

  const getStatusText = (): string => {
    switch (status) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'error': return 'Connection Error';
      default: return 'Disconnected';
    }
  };

  return (
    <aside className="w-[280px] bg-[var(--bg-panel)] border-r border-[var(--border-subtle)] flex flex-col shrink-0">
      {/* Brand */}
      <Link 
        href="/"
        className="px-4 py-4 border-b border-[var(--border-subtle)] flex items-center gap-3 cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
      >
        <span className="text-2xl">⚡</span>
        <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-[var(--accent)] to-[var(--purple)] bg-clip-text text-transparent">
          Sharp
        </span>
      </Link>

      {/* Navigation */}
      <nav className="flex-1 py-3 overflow-y-auto">
        <NavSection title="Overview">
          <NavItem 
            href="/" 
            icon="📊" 
            label="Dashboard" 
            isActive={pathname === '/'} 
          />
        </NavSection>
        <NavSection title="Agents">
          <NavItem 
            href="/sessions" 
            icon="🤖" 
            label="Sessions" 
            isActive={pathname === '/sessions' || pathname?.startsWith('/sessions/')} 
          />
        </NavSection>
        <NavSection title="Knowledge">
          <NavItem 
            href="/kb" 
            icon="📚" 
            label="Documents" 
            isActive={pathname === '/kb'} 
          />
          <NavItem 
            href="/kb/journal" 
            icon="📝" 
            label="Journal" 
            isActive={pathname?.startsWith('/kb/journal')} 
          />
        </NavSection>
      </nav>

      {/* Connection Status Footer */}
      <div className="px-4 py-3 border-t border-[var(--border-subtle)]">
        <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
          <span className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
          <span>{getStatusText()}</span>
          {isConnected && (
            <span className="ml-auto text-[var(--text-muted)]">v2.0</span>
          )}
        </div>
        <div className="text-[10px] text-[var(--text-muted)] text-center mt-1">
          ui/polish-vanilla
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
