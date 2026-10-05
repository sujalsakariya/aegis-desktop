import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown } from 'lucide-react'

/**
 * A pop-up menu in place of a native <select>, whose option list the OS draws
 * and CSS cannot style. Looks like an iOS pull-down menu (glass, checkmark on
 * the chosen item) and keeps select behaviour: arrows, Home/End, Enter/Space,
 * Escape and type-to-jump. The menu renders into <body> so cards that clip
 * their content cannot cut it off. `onChange` receives the chosen value.
 */
export function Select({ value, onChange, options, disabled = false, id, className = '', ...rest }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [place, setPlace] = useState(null)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const typed = useRef({ text: '', at: 0 })
  const listId = `${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-list`
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))

  const openMenu = () => {
    if (disabled) return
    setActive(selectedIndex)
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    setPlace(null)
    if (refocus) triggerRef.current?.focus()
  }
  const choose = (index) => {
    const option = options[index]
    close()
    if (option && option.value !== value) onChange(option.value)
  }

  // Under the trigger, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const height = Math.min(320, options.length * 42 + 14)
    const below = window.innerHeight - rect.bottom
    const up = below < height + 16 && rect.top > below
    setPlace({ left: rect.left, width: rect.width, top: up ? undefined : rect.bottom + 6, bottom: up ? window.innerHeight - rect.top + 6 : undefined, up })
  }, [open, options.length])

  // While open: focus the list; close on a click elsewhere, scrolling or resizing.
  useEffect(() => {
    if (!open || !place) return undefined
    listRef.current?.focus()
    const outside = (event) => {
      if (!listRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false)
    }
    const moved = (event) => { if (!listRef.current?.contains(event.target)) close(false) }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    window.addEventListener('blur', moved)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
      window.removeEventListener('blur', moved)
    }
  }, [open, place]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onTriggerKey = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu()
    }
  }

  const onListKey = (event) => {
    const last = options.length - 1
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(last, index + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(last) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close() }
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Type to jump, as in a native select.
      const now = event.timeStamp
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + event.key.toLowerCase(), at: now }
      const match = options.findIndex((option) => String(option.label).toLowerCase().startsWith(typed.current.text))
      if (match >= 0) setActive(match)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`select-trigger ${className}`.trim()}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
        {...rest}
      >
        <span className="select-value">{options[selectedIndex]?.label}</span>
        <ChevronsUpDown className="select-chevron" size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && place && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className={`select-menu${place.up ? ' up' : ''}`}
          style={{ left: place.left, minWidth: place.width, top: place.top, bottom: place.bottom }}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === selectedIndex}
              className={`select-option${index === active ? ' active' : ''}${index === selectedIndex ? ' selected' : ''}`}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <Check className="select-check" size={16} strokeWidth={2.5} aria-hidden="true" />
              <span>{option.label}</span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  )
}
