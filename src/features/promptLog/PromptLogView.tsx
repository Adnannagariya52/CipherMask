import React from 'react';
import { Download } from 'lucide-react';
import promptLogRaw from '../../../PROMPT_LOG.md?raw';
import { PageHeader } from '../../components/ui/PageHeader.tsx';

export const PromptLogView: React.FC = () => {
  const handleDownload = () => {
    const bytes = new TextEncoder().encode(promptLogRaw);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'PROMPT_LOG.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-8 ae-fade-in">
      <PageHeader
        eyebrow="Project Provenance"
        title="Prompt Log"
        description="Actual prompts received and verified outcomes recorded directly from repository PROMPT_LOG.md (rendered safely as plain text)."
        actions={
          <button
            type="button"
            onClick={handleDownload}
            className="ae-btn-secondary inline-flex items-center gap-2 rounded-xl px-4 h-11 text-sm cursor-pointer"
          >
            <Download className="w-4 h-4 text-[#087F6D]" aria-hidden="true" />
            <span>Download PROMPT_LOG.md</span>
          </button>
        }
      />

      <pre
        data-testid="prompt-log-content"
        className="ae-card p-6 sm:p-8 font-mono text-[13px] leading-7 whitespace-pre-wrap text-[#334155] overflow-x-auto max-h-[72vh]"
      >
        {promptLogRaw}
      </pre>
    </div>
  );
};
