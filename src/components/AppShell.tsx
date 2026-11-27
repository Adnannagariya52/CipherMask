import React, { useEffect, useState } from 'react';
import {
  Shield,
  LayoutGrid,
  FileText,
  Image as ImageIcon,
  Table2,
  FlaskConical,
  FileCheck2,
  KeyRound,
  Lock,
  TerminalSquare,
  RotateCcw,
  HelpCircle,
  Menu,
  X,
  WifiOff,
  CheckCircle2,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquareLock,
  Cpu,
} from 'lucide-react';
import { useSession, type AppModuleId } from '../state/session.tsx';
import { checkOfflineStatus, type OfflineStatusReport } from '../state/offline.ts';
import { HelpDialog } from './HelpDialog.tsx';

interface NavItem {
  id: AppModuleId;
  label: string;
  group: 'workspace' | 'intelligence' | 'trust' | 'settings';
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', group: 'workspace', icon: LayoutGrid },
  { id: 'text', label: 'Text Shield', group: 'workspace', icon: FileText },
  { id: 'vision', label: 'Vision Shield', group: 'workspace', icon: ImageIcon },
  { id: 'data', label: 'Data Shield', group: 'workspace', icon: Table2 },
  { id: 'chat', label: 'CipherChat', group: 'intelligence', icon: MessageSquareLock },
  { id: 'vault', label: 'Identity Vault', group: 'trust', icon: KeyRound },
  { id: 'benchmark', label: 'Benchmark Lab', group: 'trust', icon: FlaskConical },
  { id: 'audit', label: 'Audit & Verify', group: 'trust', icon: FileCheck2 },
  { id: 'setup', label: 'Local AI & Cloud', group: 'settings', icon: Cpu },
  { id: 'privacy', label: 'Privacy Center', group: 'settings', icon: Lock },
  { id: 'promptLog', label: 'Prompt Log', group: 'settings', icon: TerminalSquare },
];

const NAV_GROUPS: Array<{ key: NavItem['group']; heading: string }> = [
  { key: 'workspace', heading: 'Workspace' },
  { key: 'intelligence', heading: 'Intelligence' },
  { key: 'trust', heading: 'Trust & Security' },
  { key: 'settings', heading: 'Settings' },
];

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    activeModule,
    setActiveModule,
    resetSession,
    toasts,
    dismissToast,
    liveAnnouncement,
  } = useSession();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [offlineStatus, setOfflineStatus] = useState<OfflineStatusReport | null>(null);
  const [isOffline, setIsOffline] = useState<boolean>(typeof navigator !== 'undefined' ? !navigator.onLine : false);

  useEffect(() => {
    checkOfflineStatus().then(setOfflineStatus).catch(() => {});
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [activeModule]);

  const currentNav = NAV_ITEMS.find((n) => n.id === activeModule) ?? NAV_ITEMS[1];
  const currentGroup = NAV_GROUPS.find((g) => g.key === currentNav.group)?.heading ?? 'Workspace';

  const selectNav = (id: AppModuleId) => {
    setActiveModule(id);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen flex bg-[#F7F9FC] text-[#101828]">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#101828]/30 backdrop-blur-xs md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Arctic Emerald Sidebar */}
      <aside
        aria-label="Primary navigation"
        className={`fixed md:sticky top-0 left-0 z-40 h-screen flex-col border-r border-[#E2E8F0] bg-[#FFFFFF] transition-all duration-200 ${
          mobileOpen ? 'flex translate-x-0' : 'hidden md:flex -translate-x-full md:translate-x-0'
        } ${collapsed ? 'md:w-[76px]' : 'w-[272px]'}`}
      >
        <div className="flex items-center justify-between h-16 px-5 border-b border-[#EDF0F4]">
          <button
            type="button"
            onClick={() => selectNav('overview')}
            className="flex items-center gap-3 overflow-hidden text-left cursor-pointer"
          >
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#087F6D] text-white shadow-xs">
              <Shield className="w-4 h-4" aria-hidden="true" />
              <span
                aria-hidden="true"
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[#C5A66A] ring-2 ring-white"
              />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[15px] font-semibold tracking-tight text-[#101828] truncate">
                  CipherMask
                </div>
                <div className="text-[11px] font-medium text-[#64748B] truncate">
                  Privacy Intelligence
                </div>
              </div>
            )}
          </button>

          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="hidden md:inline-flex p-1.5 rounded-lg text-[#64748B] hover:text-[#101828] hover:bg-[#F1F5F9] transition-colors cursor-pointer"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1.5 rounded-lg text-[#64748B] hover:text-[#101828]"
            aria-label="Close navigation menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-5 px-3 space-y-6">
          {NAV_GROUPS.map((grp) => (
            <div key={grp.key} className="space-y-1">
              {!collapsed && (
                <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
                  {grp.heading}
                </div>
              )}
              {NAV_ITEMS.filter((n) => n.group === grp.key).map((item) => {
                const Icon = item.icon;
                const active = activeModule === item.id;
                const isAi = item.group === 'intelligence';
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`nav-${item.id}`}
                    onClick={() => selectNav(item.id)}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={`group relative w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all duration-150 cursor-pointer ${
                      active
                        ? 'bg-[#E1F5EF] text-[#087F6D] font-semibold'
                        : 'text-[#475569] hover:bg-[#F1F5F9] hover:text-[#101828] font-medium'
                    }`}
                  >
                    <Icon
                      className={`w-[18px] h-[18px] shrink-0 transition-colors ${
                        active
                          ? 'text-[#087F6D]'
                          : isAi
                            ? 'text-[#6366F1] group-hover:text-[#4338CA]'
                            : 'text-[#64748B] group-hover:text-[#101828]'
                      }`}
                    />
                    {!collapsed && (
                      <span className="text-[15px] leading-snug truncate">{item.label}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {!collapsed && (
          <div className="p-4 border-t border-[#EDF0F4] bg-[#F7F9FC]/80 text-xs text-[#64748B] space-y-1">
            <div className="flex items-center gap-1.5 text-[#087F6D] font-semibold">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Local-First Session</span>
            </div>
            <p className="leading-relaxed">Documents stay in volatile browser memory.</p>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 flex items-center justify-between gap-4 px-5 sm:px-8 lg:px-10 border-b border-[#E2E8F0] bg-[#FFFFFF]/92 backdrop-blur-md">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-2 rounded-lg border border-[#E2E8F0] text-[#475569] hover:bg-[#F1F5F9]"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>

            <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
              <span className="hidden sm:inline text-[#64748B] font-medium">{currentGroup}</span>
              <span className="hidden sm:inline text-[#CBD5E1]">/</span>
              <span className="font-semibold text-[#101828] truncate">{currentNav.label}</span>
            </nav>

            {isOffline && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FDE68A] bg-[#FFFBEB] px-3 py-1 text-xs font-medium text-[#B45309]">
                <WifiOff className="w-3.5 h-3.5" aria-hidden="true" />
                Offline
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setActiveModule('privacy')}
              className="hidden lg:inline-flex items-center gap-2 rounded-full border border-[#E2E8F0] bg-[#F7F9FC] px-3.5 h-9 text-[13px] font-medium text-[#475569] hover:border-[#087F6D]/40 hover:text-[#101828] transition-colors cursor-pointer"
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  offlineStatus?.shellReady ? 'bg-[#15803D]' : 'bg-[#087F6D]'
                }`}
              />
              <span>{offlineStatus?.shellReady ? 'Offline Ready' : 'Client-Side'}</span>
            </button>

            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="ae-btn-secondary inline-flex items-center gap-1.5 rounded-lg px-3.5 h-9 text-sm cursor-pointer"
            >
              <HelpCircle className="w-4 h-4 text-[#475569]" aria-hidden="true" />
              <span className="hidden sm:inline">Guide</span>
            </button>

            <button
              type="button"
              data-testid="reset-session-btn"
              onClick={resetSession}
              className="ae-btn-danger inline-flex items-center gap-1.5 rounded-lg px-3.5 h-9 text-sm cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>Reset Session</span>
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-10 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>

      {/* Subtle Floating Toast Notifications */}
      <div
        className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg bg-white ${
              t.kind === 'error'
                ? 'border-[#FECACA] bg-[#FEF2F2] text-[#DC2626]'
                : t.kind === 'warning'
                  ? 'border-[#FDE68A] bg-[#FFFBEB] text-[#B45309]'
                  : t.kind === 'success'
                    ? 'border-[#BBF7D0] bg-[#ECFDF3] text-[#15803D]'
                    : 'border-[#E2E8F0] bg-[#FFFFFF] text-[#101828]'
            }`}
          >
            <span className="font-medium leading-snug">{t.message}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
              className="opacity-65 hover:opacity-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
};
