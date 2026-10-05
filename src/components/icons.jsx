/**
 * Stroke icons drawn on a 24px grid, sized by the parent font-size and
 * coloured with currentColor so they follow the nav and chip states.
 */
function Svg({ children, size = 18, strokeWidth = 1.8, className = '', title }) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

export const DashboardIcon = (props) => (
  <Svg {...props}>
    <rect x="3" y="3" width="7.5" height="9" rx="1.8" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.8" />
    <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.8" />
    <rect x="3" y="15" width="7.5" height="6" rx="1.8" />
  </Svg>
)

export const CleanerIcon = (props) => (
  <Svg {...props}>
    <path d="M14.5 3.5 10 12" />
    <path d="M7.2 11.2c1.9-.8 4.6.2 5.6 2.1l.7 1.4-7.3 3.6-.7-1.4c-1-1.9-.2-4.9 1.7-5.7Z" />
    <path d="M6.2 16.9 4 20.5" />
    <path d="M9 18.5 7.8 21" />
    <path d="M18.5 9.5v3M17 11h3" />
    <path d="M19.5 16v2M18.5 17h2" />
  </Svg>
)

export const ScanIcon = (props) => (
  <Svg {...props}>
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <circle cx="11.5" cy="11.5" r="3.6" />
    <path d="m14.2 14.2 2.8 2.8" />
  </Svg>
)

export const QuarantineIcon = (props) => (
  <Svg {...props}>
    <path d="M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <path d="M3 4.5h18V8H3z" />
    <rect x="9.5" y="13" width="5" height="4" rx="1" />
    <path d="M10.5 13v-1.2a1.5 1.5 0 0 1 3 0V13" />
  </Svg>
)

export const ProtectionIcon = (props) => (
  <Svg {...props}>
    <path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6Z" />
    <path d="m8.8 12 2.2 2.2 4.2-4.4" />
  </Svg>
)

export const UpdatesIcon = (props) => (
  <Svg {...props}>
    <path d="M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5" />
    <path d="M4 4v4.5h4.5" />
    <path d="M4 12.5a8 8 0 0 0 13.7 5.2l2.3-2.2" />
    <path d="M20 20v-4.5h-4.5" />
  </Svg>
)

export const LicenseIcon = (props) => (
  <Svg {...props}>
    <circle cx="8" cy="15" r="4.2" />
    <path d="m11 12 9-9" />
    <path d="m16.5 6.5 2.5 2.5" />
    <path d="m14 9 2 2" />
  </Svg>
)

export const SettingsIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
)

export const UserIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5" />
  </Svg>
)

export const LogoutIcon = (props) => (
  <Svg {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
)

export const LockIcon = (props) => (
  <Svg {...props}>
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    <path d="M12 15v2.5" />
  </Svg>
)

export const CheckCircleIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.3 12.2 2.5 2.5 5-5.2" />
  </Svg>
)

export const AlertIcon = (props) => (
  <Svg {...props}>
    <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4" />
    <path d="M12 17h.01" />
  </Svg>
)

export const ClockIcon = (props) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 2" />
  </Svg>
)
