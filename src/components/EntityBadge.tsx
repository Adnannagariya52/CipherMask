import React from 'react';
import {
  Mail,
  Phone,
  Globe,
  CreditCard,
  Fingerprint,
  FileBadge2,
  User,
  MapPin,
  Building2,
  ScanFace,
  QrCode,
  Tag,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { ENTITY_LABELS, type EntityType, type ValidationStatus } from '../engine/types.ts';

export const CATEGORY_COLORS: Record<
  EntityType,
  { bg: string; border: string; text: string; dot: string }
> = {
  EMAIL: { bg: 'bg-[#EFF6FF]', border: 'border-[#BFDBFE]', text: 'text-[#1D4ED8]', dot: 'bg-[#2563EB]' },
  PHONE: { bg: 'bg-[#EEF2FF]', border: 'border-[#C7D2FE]', text: 'text-[#4338CA]', dot: 'bg-[#6366F1]' },
  IPV4: { bg: 'bg-[#F0FDFA]', border: 'border-[#99F6E4]', text: 'text-[#0F766E]', dot: 'bg-[#0D9488]' },
  IPV6: { bg: 'bg-[#F0FDFA]', border: 'border-[#99F6E4]', text: 'text-[#0F766E]', dot: 'bg-[#0D9488]' },
  PAN: { bg: 'bg-[#FFFBEB]', border: 'border-[#FDE68A]', text: 'text-[#B45309]', dot: 'bg-[#D97706]' },
  AADHAAR: { bg: 'bg-[#FFF7ED]', border: 'border-[#FED7AA]', text: 'text-[#C2410C]', dot: 'bg-[#EA580C]' },
  CARD: { bg: 'bg-[#FEF2F2]', border: 'border-[#FECACA]', text: 'text-[#B91C1C]', dot: 'bg-[#DC2626]' },
  PERSON: { bg: 'bg-[#EEF2FF]', border: 'border-[#C7D2FE]', text: 'text-[#4338CA]', dot: 'bg-[#6366F1]' },
  LOCATION: { bg: 'bg-[#F5F3FF]', border: 'border-[#DDD6FE]', text: 'text-[#6D28D9]', dot: 'bg-[#7C3AED]' },
  ORGANIZATION: { bg: 'bg-[#F8FAFC]', border: 'border-[#CBD5E1]', text: 'text-[#334155]', dot: 'bg-[#475569]' },
  CONTEXT_ID: { bg: 'bg-[#EEF2FF]', border: 'border-[#C7D2FE]', text: 'text-[#4338CA]', dot: 'bg-[#6366F1]' },
  FACE: { bg: 'bg-[#EEF2FF]', border: 'border-[#C7D2FE]', text: 'text-[#4338CA]', dot: 'bg-[#6366F1]' },
  PERSON_REGION: { bg: 'bg-[#F5F3FF]', border: 'border-[#DDD6FE]', text: 'text-[#6D28D9]', dot: 'bg-[#7C3AED]' },
  QR: { bg: 'bg-[#ECFEFF]', border: 'border-[#A5F3FC]', text: 'text-[#0E7490]', dot: 'bg-[#0891B2]' },
  BARCODE: { bg: 'bg-[#ECFEFF]', border: 'border-[#A5F3FC]', text: 'text-[#0E7490]', dot: 'bg-[#0891B2]' },
  METADATA: { bg: 'bg-[#F1F5F9]', border: 'border-[#CBD5E1]', text: 'text-[#475569]', dot: 'bg-[#64748B]' },
  MANUAL: { bg: 'bg-[#E1F5EF]', border: 'border-[#99E0CD]', text: 'text-[#087F6D]', dot: 'bg-[#087F6D]' },
};

export function EntityIcon({ type, className = 'w-4 h-4' }: { type: EntityType; className?: string }) {
  switch (type) {
    case 'EMAIL':
      return <Mail className={className} aria-hidden="true" />;
    case 'PHONE':
      return <Phone className={className} aria-hidden="true" />;
    case 'IPV4':
    case 'IPV6':
      return <Globe className={className} aria-hidden="true" />;
    case 'CARD':
      return <CreditCard className={className} aria-hidden="true" />;
    case 'AADHAAR':
      return <Fingerprint className={className} aria-hidden="true" />;
    case 'PAN':
      return <FileBadge2 className={className} aria-hidden="true" />;
    case 'PERSON':
      return <User className={className} aria-hidden="true" />;
    case 'LOCATION':
      return <MapPin className={className} aria-hidden="true" />;
    case 'ORGANIZATION':
      return <Building2 className={className} aria-hidden="true" />;
    case 'FACE':
    case 'PERSON_REGION':
      return <ScanFace className={className} aria-hidden="true" />;
    case 'QR':
    case 'BARCODE':
      return <QrCode className={className} aria-hidden="true" />;
    default:
      return <Tag className={className} aria-hidden="true" />;
  }
}

export const EntityBadge: React.FC<{
  type: EntityType;
  count?: number;
  active?: boolean;
  onClick?: () => void;
}> = ({ type, count, active = true, onClick }) => {
  const c = CATEGORY_COLORS[type];
  const base = `inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] font-medium transition ${c.bg} ${c.border} ${c.text} ${active ? 'opacity-100' : 'opacity-45'}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${base} cursor-pointer hover:brightness-95`}>
        <EntityIcon type={type} className="w-3.5 h-3.5" />
        <span>{ENTITY_LABELS[type]}</span>
        {count !== undefined && <span className="font-mono text-xs opacity-80">{count}</span>}
      </button>
    );
  }
  return (
    <span className={base}>
      <EntityIcon type={type} className="w-3.5 h-3.5" />
      <span>{ENTITY_LABELS[type]}</span>
      {count !== undefined && <span className="font-mono text-xs opacity-80">{count}</span>}
    </span>
  );
};

export const ValidationBadge: React.FC<{ status: ValidationStatus }> = ({ status }) => {
  switch (status) {
    case 'checksum_valid':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[#ECFDF3] border border-[#BBF7D0] px-2 py-0.5 text-xs font-medium text-[#15803D]">
          <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
          Checksum Pass
        </span>
      );
    case 'structurally_valid':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[#EFF6FF] border border-[#BFDBFE] px-2 py-0.5 text-xs font-medium text-[#2563EB]">
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
          Structurally Valid
        </span>
      );
    case 'pattern_match':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[#F1F5F9] border border-[#CBD5E1] px-2 py-0.5 text-xs font-medium text-[#475569]">
          Pattern Match
        </span>
      );
    case 'uncertain':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[#FFFBEB] border border-[#FDE68A] px-2 py-0.5 text-xs font-medium text-[#B45309]">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
          Uncertain
        </span>
      );
    case 'rejected':
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-[#FEF2F2] border border-[#FECACA] px-2 py-0.5 text-xs font-medium text-[#DC2626]">
          <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
          Rejected
        </span>
      );
  }
};
