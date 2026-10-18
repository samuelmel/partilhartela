import type { JSX, ReactNode } from 'react';
import logoUrl from './logo.png';

// Um único traço (24px, 1.8) para todos os ícones da interface.
function Svg({ children, size = 20 }: { children: ReactNode; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const ScreenIcon = ({ size }: IconProps) => (
  <Svg size={size}><rect x="2.5" y="3.5" width="19" height="13" rx="2" /><path d="M8 20.5h8M12 16.5v4" /></Svg>
);
export const StopIcon = ({ size }: IconProps) => (
  <Svg size={size}><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>
);
export const SwapIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" /></Svg>
);
export const VolumeIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></Svg>
);
export const VolumeLowIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></Svg>
);
export const VolumeOffIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m16 9 6 6M22 9l-6 6" /></Svg>
);
export const ExpandIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3" /></Svg>
);
export const CollapseIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3" /></Svg>
);
export const CopyIcon = ({ size }: IconProps) => (
  <Svg size={size}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" /></Svg>
);
export const CheckIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M20 6 9 17l-5-5" /></Svg>
);
export const UsersIcon = ({ size }: IconProps) => (
  <Svg size={size}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" /></Svg>
);
export const DownloadIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></Svg>
);
export const LeaveIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>
);
export const StatsIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>
);
export const CloseIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M18 6 6 18M6 6l12 12" /></Svg>
);
export const AlertIcon = ({ size }: IconProps) => (
  <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></Svg>
);
export const GearIcon = ({ size }: IconProps) => (
  <Svg size={size}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>
);
export const RefreshIcon = ({ size }: IconProps) => (
  <Svg size={size}><path d="M20 11a8 8 0 0 0-14.6-4.5L3 9M3 4v5h5M4 13a8 8 0 0 0 14.6 4.5L21 15M21 20v-5h-5" /></Svg>
);

/** Marca: o logo do app (mesma imagem do ícone do instalador e do favicon). */
export function BrandMark({ size = 28 }: IconProps): JSX.Element {
  return <img className="brand-mark" src={logoUrl} width={size} height={size} alt="" aria-hidden="true" />;
}
