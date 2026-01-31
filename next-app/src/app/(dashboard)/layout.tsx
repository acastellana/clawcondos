import { Sidebar } from '@/components/sidebar';
import './dashboard.css';

/**
 * Dashboard Layout Group
 * 
 * Shared layout for dashboard pages with sidebar navigation.
 * This layout wraps all dashboard routes.
 */

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg)]">
        {children}
      </div>
    </div>
  );
}
