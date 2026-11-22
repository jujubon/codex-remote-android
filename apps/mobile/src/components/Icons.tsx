import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return <IconBase {...props}><path d="M15 18 9 12l6-6" /></IconBase>;
}

export function PlusIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 5v14M5 12h14" /></IconBase>;
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63a1.7 1.7 0 0 0 1-1.55V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9c.24.61.85 1 1.55 1H21v4h-.08c-.7 0-1.31.4-1.52 1Z" />
    </IconBase>
  );
}

export function SendIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 12 7-7 7 7M12 5v14" /></IconBase>;
}

export function CloseIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" /></IconBase>;
}

export function ChevronRightIcon(props: IconProps) {
  return <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>;
}

export function ChevronDownIcon(props: IconProps) {
  return <IconBase {...props}><path d="m6 9 6 6 6-6" /></IconBase>;
}

export function ChevronUpIcon(props: IconProps) {
  return <IconBase {...props}><path d="m18 15-6-6-6 6" /></IconBase>;
}

export function StopIcon(props: IconProps) {
  return <IconBase {...props}><rect x="7" y="7" width="10" height="10" rx="1" /></IconBase>;
}

export function EyeIcon({ off = false, ...props }: IconProps & { off?: boolean }) {
  return (
    <IconBase {...props}>
      <path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" />
      <circle cx="12" cy="12" r="2.5" />
      {off && <path d="m4 4 16 16" />}
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></IconBase>;
}

export function AlertIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 16h.01" /></IconBase>;
}

export function SearchIcon(props: IconProps) {
  return <IconBase {...props}><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></IconBase>;
}

export function FolderIcon(props: IconProps) {
  return <IconBase {...props}><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></IconBase>;
}

export function ChatIcon(props: IconProps) {
  return <IconBase {...props}><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.7-3.1A7.5 7.5 0 1 1 20 11.5Z" /><path d="M9 11.5h6" /></IconBase>;
}

export function MoreIcon(props: IconProps) {
  return <IconBase {...props}><g fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </g></IconBase>;
}

export function MonitorIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M12 17v3m-4 0h8" /></IconBase>;
}
