import React from 'react';
import { SessionProvider, useSession } from './state/session.tsx';
import { AppShell } from './components/AppShell.tsx';
import { TextShield } from './features/text/TextShield.tsx';
import { VisionShield } from './features/vision/VisionShield.tsx';
import { DataShield } from './features/data/DataShield.tsx';
import { BenchmarkLab } from './features/benchmark/BenchmarkLab.tsx';
import { AuditPanel } from './features/audit/AuditPanel.tsx';
import { IdentityVault } from './features/vault/IdentityVault.tsx';
import { PrivacyCenter } from './features/privacy/PrivacyCenter.tsx';
import { PromptLogView } from './features/promptLog/PromptLogView.tsx';
import { CipherChat } from './chat/CipherChat.tsx';
import { ModelSetupPanel } from './features/setup/ModelSetupPanel.tsx';
import { OverviewPage } from './features/overview/OverviewPage.tsx';

const ModuleRouter: React.FC = () => {
  const { activeModule, resetCounter } = useSession();

  switch (activeModule) {
    case 'overview':
      return <OverviewPage />;
    case 'chat':
      return <CipherChat key={`chat_${resetCounter}`} />;
    case 'text':
      return <TextShield key={`text_${resetCounter}`} />;
    case 'vision':
      return <VisionShield key={`vision_${resetCounter}`} />;
    case 'data':
      return <DataShield key={`data_${resetCounter}`} />;
    case 'benchmark':
      return <BenchmarkLab />;
    case 'audit':
      return <AuditPanel />;
    case 'vault':
      return <IdentityVault key={`vault_${resetCounter}`} />;
    case 'setup':
      return <ModelSetupPanel />;
    case 'privacy':
      return <PrivacyCenter />;
    case 'promptLog':
      return <PromptLogView />;
  }
};

export const App: React.FC = () => {
  return (
    <SessionProvider>
      <AppShell>
        <ModuleRouter />
      </AppShell>
    </SessionProvider>
  );
};

export default App;
