import fs from 'node:fs/promises'
import path from 'node:path'

export const SCHEDULE_KEYS = ['daily', 'weekly', 'monthly', 'startup']
export const INTERVALS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 30 * 24 * 60 * 60 * 1000 }
export const TICK_MS = 60 * 1000

export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Object.keys(schedule).some((key) => !SCHEDULE_KEYS.includes(key)) || Object.values(schedule).some((value) => typeof value !== 'boolean')) throw new Error('Invalid schedule')
  return { daily: Boolean(schedule.daily), weekly: Boolean(schedule.weekly), monthly: Boolean(schedule.monthly), startup: Boolean(schedule.startup) }
}

/**
 * When a periodic schedule is next due. The clock starts when the schedule was
 * switched on and restarts from each run, so launching the app or changing a
 * setting never resets it. Returns null when the schedule is off.
 */
export function nextRunAt(name, schedule, state) {
  if (!INTERVALS[name] || !schedule?.[name]) return null
  const entry = state?.[name] || {}
  const base = Math.max(Number(entry.lastRun) || 0, Number(entry.enabledAt) || 0)
  return base ? base + INTERVALS[name] : null
}

/** Periodic schedules whose interval has elapsed at `now`. */
export function dueSchedules(schedule, state, now = Date.now()) {
  return Object.keys(INTERVALS).filter((name) => {
    const next = nextRunAt(name, schedule, state)
    return next !== null && next <= now
  })
}

/** Records enabledAt for newly switched-on schedules and clears it for switched-off ones. */
export function reconcileState(schedule, state, now = Date.now()) {
  const next = { ...(state || {}) }
  for (const name of Object.keys(INTERVALS)) {
    const entry = { ...(next[name] || {}) }
    if (schedule[name] && !entry.enabledAt) entry.enabledAt = now
    if (!schedule[name]) delete entry.enabledAt
    next[name] = entry
  }
  return next
}

/**
 * Runs scheduled quick scans. A single one-minute tick checks which schedules
 * are due against run times persisted on disk, starts at most one scan, and
 * leaves a due schedule pending (retried next tick) when the scanner is busy.
 */
export class ScanScheduler {
  #scanner
  #statePath
  #state = {}
  #schedule = { daily: false, weekly: false, monthly: false, startup: false }
  #active = false
  #timer = null
  #startupPending = false
  #startupDone = false
  #listeners = new Set()

  constructor(scanner, userDataPath) {
    this.#scanner = scanner
    this.#statePath = path.join(userDataPath, 'scheduler.json')
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.#statePath, 'utf8'))
      this.#state = parsed && typeof parsed === 'object' ? parsed : {}
    } catch { this.#state = {} }
  }

  /** Fires with the list of schedule names that started a scan. */
  onRun(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  getStatus() {
    const nextRuns = {}
    const lastRuns = {}
    for (const name of Object.keys(INTERVALS)) {
      const next = this.#active ? nextRunAt(name, this.#schedule, this.#state) : null
      nextRuns[name] = next ? new Date(next).toISOString() : null
      lastRuns[name] = this.#state[name]?.lastRun ? new Date(this.#state[name].lastRun).toISOString() : null
    }
    return { ...this.#schedule, active: this.#active, nextRuns, lastRuns, startupPending: this.#startupPending }
  }

  /**
   * `schedule` is the user's saved choice; `active` says whether scans may run
   * (licensed and automatic scanning on). Saved choices keep their clocks even
   * while inactive.
   */
  async configure(schedule, { active = true } = {}) {
    this.#schedule = validateSchedule(schedule)
    this.#active = Boolean(active)
    this.#state = reconcileState(this.#schedule, this.#state)
    await this.#save()
    if (this.#active && !this.#timer) this.#timer = setInterval(() => { this.tick() }, TICK_MS)
    if (!this.#active) this.stop()
    return this.getStatus()
  }

  /** Queues the once-per-launch startup scan if that schedule is on. */
  runStartup() {
    if (this.#startupDone || !this.#schedule.startup || !this.#active) return
    this.#startupDone = true
    this.#startupPending = true
    this.tick()
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; this.#startupPending = false }

  /** One scheduler pass; normally driven by the one-minute interval. */
  async tick() {
    if (!this.#active) return
    const due = dueSchedules(this.#schedule, this.#state)
    if (this.#startupPending) due.unshift('startup')
    if (!due.length) return
    if (this.#scanner.isBusy()) return // Still due; the next tick retries.
    try {
      await this.#scanner.start({ mode: 'quick', source: due.includes('startup') && due.length === 1 ? 'startup' : 'scheduled' })
    } catch {
      return // Busy or refused (for example no signatures reachable): retry next tick.
    }
    const now = Date.now()
    for (const name of due) {
      if (name === 'startup') { this.#startupPending = false; continue }
      this.#state[name] = { ...(this.#state[name] || {}), lastRun: now }
    }
    await this.#save()
    for (const listener of this.#listeners) { try { listener(due) } catch { /* ignore */ } }
  }

  async #save() {
    try {
      await fs.mkdir(path.dirname(this.#statePath), { recursive: true })
      const temporary = `${this.#statePath}.tmp`
      await fs.writeFile(temporary, JSON.stringify(this.#state), { mode: 0o600 })
      await fs.rename(temporary, this.#statePath)
    } catch { /* Best effort: a failed write only means a schedule may run again. */ }
  }
}
