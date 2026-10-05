import {
  Archive,
  CircleCheck,
  CircleUserRound,
  Clock,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  RefreshCw,
  ScanSearch,
  Settings,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'

/**
 * The app's icons, from Lucide (https://lucide.dev, ISC licence). Colour
 * follows currentColor. `filled` marks the selected sidebar item and white
 * glyphs on coloured tiles; Lucide icons are outlines, so it draws them with
 * a bolder stroke.
 */
function lucide(Component) {
  function AppIcon({ size = 18, strokeWidth, filled = false, className = '', title }) {
    return (
      <Component
        className={`icon${filled ? ' icon-filled' : ''} ${className}`.trim()}
        size={size}
        strokeWidth={strokeWidth ?? (filled ? 2.3 : 1.8)}
        absoluteStrokeWidth={false}
        aria-hidden={title ? undefined : 'true'}
        aria-label={title}
        role={title ? 'img' : undefined}
      />
    )
  }
  AppIcon.displayName = `${Component.displayName || 'Lucide'}Icon`
  return AppIcon
}

export const DashboardIcon = lucide(LayoutDashboard)
export const ScanIcon = lucide(ScanSearch)
export const QuarantineIcon = lucide(Archive)
export const CleanerIcon = lucide(Sparkles)
export const ProtectionIcon = lucide(ShieldCheck)
export const UpdatesIcon = lucide(RefreshCw)
export const LicenseIcon = lucide(KeyRound)
export const SettingsIcon = lucide(Settings)
export const UserIcon = lucide(CircleUserRound)
export const LogoutIcon = lucide(LogOut)
export const LockIcon = lucide(Lock)
export const CheckCircleIcon = lucide(CircleCheck)
export const AlertIcon = lucide(TriangleAlert)
export const ClockIcon = lucide(Clock)
