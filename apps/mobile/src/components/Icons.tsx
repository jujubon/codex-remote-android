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

export function MailIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></IconBase>;
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

export function ArchiveIcon(props: IconProps) {
  return <IconBase {...props}><rect x="3" y="4" width="18" height="5" rx="1.3" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9m-9 4h4" /></IconBase>;
}

export function GaugeIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4.2 18a9 9 0 1 1 15.6 0M12 13l4-4M7 13h.01m5-5h.01m5 5h.01" /><circle cx="12" cy="13" r="1" /></IconBase>;
}

export function TrashIcon(props: IconProps) {
  return <IconBase {...props}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" /></IconBase>;
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

export function PowerIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 3v9M6.5 6.5a8 8 0 1 0 11 0" /></IconBase>;
}

export function EditIcon(props: IconProps) {
  return <IconBase {...props}><path d="m14 5 5 5M4 20l4.8-1 11-11a2 2 0 0 0-2.8-2.8l-11 11L4 20Z" /></IconBase>;
}

export function ClipboardIcon(props: IconProps) {
  return <IconBase {...props}><rect x="8" y="3" width="8" height="4" rx="1.5" /><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M8 12h8m-8 4h6" /></IconBase>;
}

export function UploadIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 15V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></IconBase>;
}

export function UpdateIcon(props: IconProps) {
  return <IconBase {...props}><path d="M19 10a7 7 0 1 0-1.5 7M19 5v5h-5m5 5v4m-2-2h4" /></IconBase>;
}

export function CheckIcon(props: IconProps) {
  return <IconBase {...props}><path d="m5 12 4 4L19 6" /></IconBase>;
}
