import { useCallback, useEffect, useState } from 'react'
import * as api from './bridge'

/**
 * Loads every module's state once, then keeps scanner, realtime and USB in sync
 * through their push channels. Returns state plus the actions views need.
 */
export function useAegis(notifyError) {
  const [ready, setReady] = useState(false)
  const [bridgeError, setBridgeError] = useState(null)
  const [settings, setSettings] = useState(null)
  const [licenseStatus, setLicenseStatus] = useState(null)
  const [account, setAccount] = useState(null)
  const [definitionInfo, setDefinitionInfo] = useState(null)
  const [scannerStatus, setScannerStatus] = useState(null)
  const [realtimeStatus, setRealtimeStatus] = useState(null)
  const [usbStatus, setUsbStatus] = useState(null)
  const [schedulerStatus, setSchedulerStatus] = useState(null)
  // Next/last run times from the scheduler (the toggles use schedulerStatus).
  const [scheduleInfo, setScheduleInfo] = useState(null)
  const [allowedItems, setAllowedItems] = useState([])
  const [quarantineItems, setQuarantineItems] = useState([])
  const [updateEvents, setUpdateEvents] = useState([])
  const [historySummary, setHistorySummary] = useState(null)

  const refreshHistory = useCallback(async () => {
    const result = await api.history.summary()
    if (result.ok) setHistorySummary(result.data)
    return result
  }, [])

  const refreshAllowed = useCallback(async () => {
    const result = await api.quarantine.allowed()
    if (result.ok) setAllowedItems(Array.isArray(result.data) ? result.data : [])
    return result
  }, [])

  // Restoring a file adds it to the allowed list, so refresh both together.
  const refreshQuarantine = useCallback(async () => {
    const [result] = await Promise.all([api.quarantine.list(), refreshAllowed()])
    if (result.ok) setQuarantineItems(Array.isArray(result.data) ? result.data : [])
    return result
  }, [refreshAllowed])

  const refreshLicense = useCallback(async () => {
    const result = await api.license.status()
    if (result.ok) setLicenseStatus(result.data)
    return result
  }, [])

  const refreshDefinitions = useCallback(async () => {
    const result = await api.scanner.definitions()
    if (result.ok) setDefinitionInfo(result.data)
    return result
  }, [])

  const refreshAccount = useCallback(async () => {
    const result = await api.license.account()
    if (result.ok) setAccount(result.data || null)
    return result
  }, [])

  // The saved schedule is what the toggles show; timers only run while licensed.
  const refreshScheduler = useCallback(async () => {
    const [result, info] = await Promise.all([api.scheduler.saved(), api.scheduler.status()])
    if (result.ok) setSchedulerStatus(result.data)
    if (info.ok) setScheduleInfo(info.data)
    return result
  }, [])

  // Theme: light, dark, or follow the OS live. index.css keys off data-theme.
  const themePreference = settings?.theme || 'system'
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = () => {
      const resolved = themePreference === 'system' ? (media?.matches ? 'dark' : 'light') : themePreference
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
    }
    apply()
    if (themePreference !== 'system' || !media) return undefined
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [themePreference])

  // Initial load.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      const [
        settingsResult,
        licenseResult,
        scannerResult,
        realtimeResult,
        usbResult,
        schedulerResult,
        quarantineResult,
        historyResult,
        accountResult,
        definitionsResult,
        scheduleInfoResult,
        allowedResult,
        updateLogResult,
      ] = await Promise.all([
        api.settings.get(),
        api.license.status(),
        api.scanner.status(),
        api.realtime.status(),
        api.usb.status(),
        api.scheduler.saved(),
        api.quarantine.list(),
        api.history.summary(),
        api.license.account(),
        api.scanner.definitions(),
        api.scheduler.status(),
        api.quarantine.allowed(),
        api.updates.log(),
      ])

      if (cancelled) return

      if (!settingsResult.ok && !api.isDesktop) {
        setBridgeError('Live device data is unavailable because the app is not running inside Electron.')
      } else if (!settingsResult.ok) {
        setBridgeError(settingsResult.error)
      }

      if (settingsResult.ok) setSettings(settingsResult.data)
      if (licenseResult.ok) setLicenseStatus(licenseResult.data)
      if (scannerResult.ok) setScannerStatus(scannerResult.data)
      if (realtimeResult.ok) setRealtimeStatus(realtimeResult.data)
      if (usbResult.ok) setUsbStatus(usbResult.data)
      if (schedulerResult.ok) setSchedulerStatus(schedulerResult.data)
      if (quarantineResult.ok) setQuarantineItems(Array.isArray(quarantineResult.data) ? quarantineResult.data : [])
      if (historyResult.ok) setHistorySummary(historyResult.data)
      if (accountResult.ok) setAccount(accountResult.data || null)
      if (definitionsResult.ok) setDefinitionInfo(definitionsResult.data)
      if (scheduleInfoResult.ok) setScheduleInfo(scheduleInfoResult.data)
      if (allowedResult.ok) setAllowedItems(Array.isArray(allowedResult.data) ? allowedResult.data : [])
      if (updateLogResult.ok && Array.isArray(updateLogResult.data)) setUpdateEvents(updateLogResult.data)
      setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  // Live channels.
  useEffect(() => {
    const offScanner = api.scanner.onUpdate(setScannerStatus)
    const offRealtime = api.realtime.onUpdate(setRealtimeStatus)
    const offUsb = api.usb.onUpdate(setUsbStatus)
    // The main process pushes every licence change (activation, expiry,
    // suspension found on re-check). Module states follow it, so refresh them.
    const offLicense = api.license.onUpdate(async (status) => {
      setLicenseStatus(status)
      const [realtimeResult, usbResult, accountResult, scheduleResult] = await Promise.all([api.realtime.status(), api.usb.status(), api.license.account(), api.scheduler.status()])
      if (realtimeResult.ok) setRealtimeStatus(realtimeResult.data)
      if (usbResult.ok) setUsbStatus(usbResult.data)
      if (accountResult.ok) setAccount(accountResult.data || null)
      if (scheduleResult.ok) setScheduleInfo(scheduleResult.data)
    })
    const offUpdates = api.updates.onUpdate((event) => {
      // The main process saves the event (merging repeats), then the saved log is shown.
      setTimeout(() => {
        api.updates.log().then((result) => { if (result.ok && Array.isArray(result.data)) setUpdateEvents(result.data) })
      }, 150)
      if (event?.type === 'definitions-updated') {
        api.scanner.definitions().then((result) => { if (result.ok) setDefinitionInfo(result.data) })
        api.history.summary().then((result) => { if (result.ok) setHistorySummary(result.data) })
      }
    })
    return () => {
      offScanner()
      offRealtime()
      offUsb()
      offLicense()
      offUpdates()
    }
  }, [])

  // Quarantine has no push channel, so refresh it whenever a scan finishes,
  // a scan quarantines something, or a realtime detection happens.
  useEffect(() => {
    if (scannerStatus?.quarantined) refreshQuarantine()
  }, [scannerStatus?.quarantined, refreshQuarantine])

  useEffect(() => {
    if (!scannerStatus) return
    if (['completed', 'cancelled', 'failed'].includes(scannerStatus.state)) { refreshQuarantine(); refreshHistory() }
    if (scannerStatus.state === 'running') api.scheduler.status().then((result) => { if (result.ok) setScheduleInfo(result.data) })
  }, [scannerStatus?.state, refreshQuarantine, refreshHistory]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (realtimeStatus?.lastEvent?.detected) { refreshQuarantine(); refreshHistory() }
  }, [realtimeStatus?.lastEvent?.at, realtimeStatus?.lastEvent?.detected, refreshQuarantine, refreshHistory])

  /** Writes a settings patch and mirrors the side effects the main process applies. */
  const updateSettings = useCallback(
    async (patch) => {
      const result = await api.settings.update(patch)
      if (result.ok) {
        setSettings(result.data)
        const [realtimeResult, usbResult, schedulerResult, scheduleInfoResult] = await Promise.all([
          api.realtime.status(),
          api.usb.status(),
          api.scheduler.saved(),
          api.scheduler.status(),
        ])
        if (realtimeResult.ok) setRealtimeStatus(realtimeResult.data)
        if (usbResult.ok) setUsbStatus(usbResult.data)
        if (schedulerResult.ok) setSchedulerStatus(schedulerResult.data)
        if (scheduleInfoResult.ok) setScheduleInfo(scheduleInfoResult.data)
      } else if (notifyError) {
        notifyError('Could not save that setting', result.error)
      }
      return result
    },
    [notifyError],
  )

  /** Ends the session, releasing this device's licence seat first. */
  const signOut = useCallback(async () => {
    const result = await api.license.logout()
    if (result.ok) {
      setLicenseStatus(result.data)
      setAccount(null)
      const [realtimeResult, usbResult] = await Promise.all([api.realtime.status(), api.usb.status()])
      if (realtimeResult.ok) setRealtimeStatus(realtimeResult.data)
      if (usbResult.ok) setUsbStatus(usbResult.data)
    }
    return result
  }, [])

  return {
    ready,
    bridgeError,
    isDesktop: api.isDesktop,
    settings,
    licenseStatus,
    account,
    setAccount,
    definitionInfo,
    refreshDefinitions,
    refreshAccount,
    signOut,
    scannerStatus,
    realtimeStatus,
    usbStatus,
    schedulerStatus,
    scheduleInfo,
    quarantineItems,
    allowedItems,
    refreshAllowed,
    updateEvents,
    historySummary,
    refreshHistory,
    setScannerStatus,
    setRealtimeStatus,
    setUsbStatus,
    setLicenseStatus,
    setSchedulerStatus,
    updateSettings,
    refreshQuarantine,
    refreshLicense,
    refreshScheduler,
  }
}
