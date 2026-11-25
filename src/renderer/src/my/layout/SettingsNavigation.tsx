import { useId, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { useApp } from '../../store'
import { useMy } from '../store'
import { getSettingsDestination, SETTINGS_DESTINATIONS, type SettingsDestination } from '../settings-catalog'
import '../../pages/settings/settings-navigation.css'

const SETTINGS_GROUPS = [...new Set(SETTINGS_DESTINATIONS.map((destination) => destination.group))]

export function SettingsNavigation(): JSX.Element {
  const page = useApp((state) => state.page)
  const setPage = useApp((state) => state.setPage)
  const settingsView = useMy((state) => state.settingsView)
  const setSettingsView = useMy((state) => state.setSettingsView)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const navigationRef = useRef<HTMLElement>(null)
  const resultsId = useId()
  const headingId = useId()
  const active = getSettingsDestination(page, settingsView)
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const visibleDestinations = SETTINGS_DESTINATIONS.filter((destination) => {
    const searchable = [destination.title, ...destination.keywords].join(' ').normalize('NFKC').toLocaleLowerCase()
    return terms.every((term) => searchable.includes(term))
  })

  const clearSearch = (): void => {
    setQuery('')
    searchRef.current?.focus()
  }

  const navigate = (destination: SettingsDestination): void => {
    if (destination.view !== undefined) setSettingsView(destination.view)
    if (useApp.getState().page !== destination.page) setPage(destination.page)
  }

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const buttons = Array.from(navigationRef.current?.querySelectorAll<HTMLButtonElement>('[data-settings-destination]') ?? [])
    const index = buttons.indexOf(event.currentTarget)
    if (index < 0) return
    let target: HTMLButtonElement | undefined
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': target = buttons[(index + 1) % buttons.length]; break
      case 'ArrowUp':
      case 'ArrowLeft': target = buttons[(index - 1 + buttons.length) % buttons.length]; break
      case 'Home': target = buttons[0]; break
      case 'End': target = buttons[buttons.length - 1]; break
      default: return
    }
    if (target) {
      event.preventDefault()
      target.focus()
    }
  }

  return <div className="my-settings-navigation">
    <div className="my-settings-navigation-search">
      <Search className="my-settings-navigation-search-icon" aria-hidden="true" />
      <input
        ref={searchRef}
        type="text"
        inputMode="search"
        aria-label="搜索设置"
        aria-controls={resultsId}
        placeholder="搜索设置"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="my-input my-settings-navigation-search-input"
      />
      {query.length > 0 && <button type="button" aria-label="清除搜索" title="清除搜索" onClick={clearSearch} className="my-icon-control my-settings-navigation-clear">
        <X aria-hidden="true" />
      </button>}
    </div>
    <nav ref={navigationRef} id={resultsId} aria-label="设置分类" className="my-settings-navigation-results my-scrollbar my-fade-scroll">
      {SETTINGS_GROUPS.map((group, groupIndex) => {
        const destinations = visibleDestinations.filter((destination) => destination.group === group)
        if (destinations.length === 0) return null
        const groupHeadingId = `${headingId}-${groupIndex}`
        return <section key={group} aria-labelledby={groupHeadingId} className="my-settings-navigation-group">
          <h3 id={groupHeadingId} className="my-settings-navigation-heading">{group}</h3>
          <ul className="my-settings-navigation-list">
            {destinations.map((destination) => {
              const Icon = destination.icon
              const selected = active.id === destination.id
              return <li key={destination.id}>
                <button
                  type="button"
                  data-settings-destination={destination.id}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => navigate(destination)}
                  onKeyDown={moveFocus}
                  className={`my-nav-item my-settings-navigation-item${selected ? ' is-selected' : ''}`}
                >
                  <span className="my-settings-navigation-icon" aria-hidden="true"><Icon /></span>
                  <span className="my-settings-navigation-title">{destination.title}</span>
                </button>
              </li>
            })}
          </ul>
        </section>
      })}
      {visibleDestinations.length === 0 && <div className="my-settings-navigation-empty">
        <p className="my-settings-navigation-empty-title">未找到相关设置</p>
        <p>试试其他名称或关键词。</p>
        <button type="button" onClick={clearSearch} className="my-control my-button-ghost">清除搜索</button>
      </div>}
    </nav>
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{terms.length > 0 ? `找到 ${visibleDestinations.length} 项设置` : ''}</p>
  </div>
}
