import React from 'react';

interface PageHeaderProps {
  title: string;
  description: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  eyebrow,
  actions,
}) => {
  return (
    <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-[#EDF0F4]">
      <div className="space-y-1.5 max-w-3xl">
        {eyebrow && (
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#087F6D]">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[28px] sm:text-[34px] font-semibold leading-[1.18] tracking-[-0.025em] text-[#101828]">
          {title}
        </h1>
        <p className="text-[15px] sm:text-base leading-relaxed text-[#475569]">
          {description}
        </p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
    </header>
  );
};
