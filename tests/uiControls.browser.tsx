import { useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Copy, X, RefreshCw } from 'lucide-react';
import { Button } from '../src/components/ui/Button';
import { Input } from '../src/components/ui/Input';
import { IconButton } from '../src/components/ui/IconButton';
import { PanelHeader } from '../src/components/ui/PanelHeader';
import { Toolbar } from '../src/components/ui/Toolbar';
import { Switch } from '../src/components/ui/Switch';
import { Toggle } from '../src/components/settings/common/Toggle';
import { SettingsGroup } from '../src/components/settings/common/SettingsGroup';
import { SettingsNavigation, settingsPanelId, settingsTabId, type SettingsSection } from '../src/components/settings/SettingsNavigation';
import '../src/index.css';
import './uiControls.browser.css';

/** Development-only fixtures: production components, no app store or native bridge. */
function ControlExamples({ theme }: { theme: 'dark' | 'light' }) {
  const [value, setValue] = useState('My workspace');
  const [submissions, setSubmissions] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [actions, setActions] = useState(0);
  const [parentActions, setParentActions] = useState(0);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [switchChanges, setSwitchChanges] = useState(0);
  const changeSwitch = (value: boolean) => { setEnabled(value); setSwitchChanges(count => count + 1); };
  const inputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<SettingsSection>('general');
  const [jsonOpens, setJsonOpens] = useState(0);
  return <section className="control-gallery-panel" data-gallery-theme={theme} aria-label={`${theme} controls`}>
    <h2>{theme === 'dark' ? 'Dark' : 'Light'} theme</h2>
    <p>Theme fixtures use the existing app color contract.</p>
    <div className="flex border border-app-border" data-settings-navigation>
      <SettingsNavigation idPrefix={`${theme}-settings`} activeTab={section} onTabChange={setSection}
        onOpenJson={() => setJsonOpens(count => count + 1)} aboutBadge aboutBadgeLabel="Fixture update available" />
      <div role="tabpanel" id={settingsPanelId(`${theme}-settings`)} aria-labelledby={settingsTabId(`${theme}-settings`, section)} className="min-w-0 p-4">
        <p>Selected section: {section}</p>
        <Input label={`${theme} section input`} placeholder="Arrow keys here do not change sections" />
        <Button type="button">Panel action</Button>
        <output>JSON opens: {jsonOpens}</output>
      </div>
    </div>
    <div className="control-gallery-row">
      <Button type="button" data-primary>Primary</Button>
      <Button type="button" variant="secondary">Secondary</Button>
      <Button type="button" variant="ghost">Ghost</Button>
      <Button type="button" variant="danger">Danger</Button>
    </div>
    <div className="control-gallery-row">
      <Button type="button" size="sm">Small</Button>
      <Button type="button" size="md" data-medium>Medium</Button>
      <Button type="button" size="lg">Large</Button>
      <Button type="button" size="icon" aria-label="Add item"><Plus size={16} /></Button>
    </div>
    <div className="control-gallery-row">
      <Button type="button" disabled>Disabled</Button>
      <Button type="button" isLoading data-loading>Saving</Button>
      <Button type="button" variant="secondary" className="h-7 rounded-none text-xs" data-compact>Caller override</Button>
    </div>
    <form onSubmit={event => { event.preventDefault(); setSubmissions(count => count + 1); }}>
      <Input ref={inputRef} id={`${theme}-name`} label="Workspace name" value={value} onChange={event => setValue(event.target.value)} data-standard />
      <Input id={`${theme}-invalid`} label="Required field" error="Enter a display name." aria-describedby={`${theme}-hint`} data-invalid />
      <p id={`${theme}-hint`}>This fixture does not rename any real workspace.</p>
      <Input label="Disabled field" value="Unavailable" disabled />
      <Input label="Read-only field" value="Readable, selectable text" readOnly />
      <Input label="Password" type={showPassword ? 'text' : 'password'} defaultValue="fixture only" rightElement={
        <button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button>
      } />
      <Input label="Caller-sized field" className="h-7 rounded-none text-xs" placeholder="Compact override" data-compact-input />
      <div className="control-gallery-row">
        <Button type="button" variant="secondary" onClick={() => inputRef.current?.focus()}>Focus name</Button>
        <Button type="submit" data-submit>Submit fixture</Button>
      </div>
      <output aria-live="polite">Submissions: {submissions}</output>
      <div className="control-gallery-row">
        <Switch label={`${theme} compact preview`} checked={enabled} onCheckedChange={changeSwitch} data-switch />
        <Switch label={`${theme} disabled off`} checked={false} onCheckedChange={changeSwitch} disabled data-disabled-switch />
        <Switch label={`${theme} disabled on`} checked onCheckedChange={changeSwitch} disabled />
      </div>
      <Toggle label={`${theme} labeled preview`} description="This entire row toggles the same fixture value. No real setting is changed."
        checked={enabled} onChange={changeSwitch} />
      <output aria-live="polite">Switch changes: {switchChanges}; enabled: {String(enabled)}</output>
      {[240, 480].map(width => <div key={width} data-settings-layout className="max-w-full space-y-4" style={{ width }}>
        <SettingsGroup>
          <Toggle label="Boxed setting" description="A long description wraps without pushing the switch out of its column."
            checked={enabled} onChange={changeSwitch} />
          <div className="px-4 pb-3 text-xs text-app-muted">Additional setting details</div>
        </SettingsGroup>
        <SettingsGroup plain>
          <Toggle label="Plain setting" description="Same right gutter." checked={!enabled} onChange={value => changeSwitch(!value)} />
          <SettingsGroup>
            <div className="px-4 pt-3 text-xs text-app-muted">Nested provider group</div>
            <Toggle label="Nested setting" description="Disabled, but not a different size." checked={enabled} onChange={changeSwitch} disabled />
          </SettingsGroup>
        </SettingsGroup>
      </div>)}
      <div className="control-gallery-row" aria-label={`${theme} switch geometry fixtures`}>
        {[0.875, 1, 1.25].map(scale => <div key={scale} className="flex items-center gap-2" style={{
          '--zync-switch-width': `${44 * scale}px`,
          '--zync-switch-height': `${24 * scale}px`,
          '--zync-switch-inset': `${2 * scale}px`,
        } as CSSProperties}>
          <span>{scale * 100}%</span>
          {[false, true].map(checked => <Switch key={String(checked)} label={`${theme} ${scale} ${checked ? 'on' : 'off'}`}
            checked={checked} onCheckedChange={() => {}} disabled data-switch-geometry />)}
        </div>)}
      </div>
    </form>
    <div data-layout-example className="mt-6 w-full max-w-[320px] border border-app-border" onClick={() => setParentActions(count => count + 1)}>
      <PanelHeader title="A long panel title that must not cover the actions" titleId={`${theme}-panel-title`} headingLevel={3}
        icon={<Plus size={16} />} actions={<IconButton label="Close preview panel" icon={<X size={16} />} onClick={event => { event.stopPropagation(); setActions(count => count + 1); }} />} />
      <form className="p-2" onSubmit={event => { event.preventDefault(); setSubmissions(count => count + 1); }}>
        <Toolbar label={`${theme} preview actions`}>
          <IconButton ref={actionRef} label="Copy preview" icon={<Copy size={16} />} data-icon-action onClick={event => { event.stopPropagation(); setActions(count => count + 1); }} />
          <IconButton label="Disabled preview" icon={<X size={16} />} disabled />
          <IconButton label="Loading preview" icon={<RefreshCw size={16} />} isLoading data-loading-icon />
          <Button type="button" size="sm" onClick={event => { event.stopPropagation(); actionRef.current?.focus(); }}>Focus copy</Button>
        </Toolbar>
      </form>
      <output className="block p-2" aria-live="polite">Actions: {actions}; parent actions: {parentActions}</output>
    </div>
  </section>;
}

/** Check real computed styles and native behavior; throws on a failed contract. */
function runChecks(): string[] {
  const results: string[] = [];
  const check = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message);
    results.push(`PASS ${message}`);
  };
  for (const theme of ['dark', 'light']) {
    const panel = document.querySelector<HTMLElement>(`[data-gallery-theme="${theme}"]`)!;
    const navigation = panel.querySelector<HTMLElement>('[data-settings-navigation]')!;
    const list = navigation.querySelector<HTMLElement>('[role="tablist"]')!;
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const settingsPanel = navigation.querySelector<HTMLElement>('[role="tabpanel"]')!;
    const jsonAction = [...navigation.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'settings.json')!;
    check(tabs.length === 10 && list.getAttribute('aria-orientation') === 'vertical', `${theme}: vertical settings sections`);
    check(tabs.filter(tab => tab.tabIndex === 0).length === 1, `${theme}: single section Tab stop`);
    check(!list.contains(jsonAction) && !jsonAction.hasAttribute('role') && jsonAction.tabIndex === 0, `${theme}: JSON is a separate action`);
    check(tabs.every(tab => tab.getAttribute('aria-controls') === settingsPanel.id)
      && settingsPanel.getAttribute('aria-labelledby') === tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.id,
      `${theme}: selected section labels the settings panel`);
    const medium = panel.querySelector<HTMLButtonElement>('[data-medium]')!;
    const input = panel.querySelector<HTMLInputElement>('[data-standard]')!;
    const invalid = panel.querySelector<HTMLInputElement>('[data-invalid]')!;
    const compact = panel.querySelector<HTMLButtonElement>('[data-compact]')!;
    const compactInput = panel.querySelector<HTMLInputElement>('[data-compact-input]')!;
    const loading = panel.querySelector<HTMLButtonElement>('[data-loading]')!;
    check(getComputedStyle(medium).height === getComputedStyle(input).height, `${theme}: input/button height matches`);
    check(getComputedStyle(medium).borderRadius === getComputedStyle(input).borderRadius, `${theme}: input/button radius matches`);
    check(getComputedStyle(compact).height === '28px' && getComputedStyle(compactInput).height === '28px', `${theme}: caller height override`);
    check(getComputedStyle(compact).borderRadius === '0px', `${theme}: caller radius override`);
    const layout = panel.querySelector<HTMLElement>('[data-layout-example]')!;
    const action = panel.querySelector<HTMLButtonElement>('[data-icon-action]')!;
    const loadingIcon = panel.querySelector<HTMLButtonElement>('[data-loading-icon]')!;
    check(action.type === 'button', `${theme}: icon action cannot submit implicitly`);
    check(loadingIcon.disabled && loadingIcon.getAttribute('aria-busy') === 'true', `${theme}: loading icon blocks activation`);
    check(layout.scrollWidth <= layout.clientWidth, `${theme}: narrow header and actions fit`);
    const switchControl = panel.querySelector<HTMLButtonElement>('[data-switch]')!;
    const disabledSwitch = panel.querySelector<HTMLButtonElement>('[data-disabled-switch]')!;
    const track = switchControl.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    check(switchControl.type === 'button' && switchControl.getAttribute('role') === 'switch', `${theme}: switch semantics and form safety`);
    check(disabledSwitch.disabled, `${theme}: native disabled switch`);
    check(getComputedStyle(track).width === '44px' && getComputedStyle(track).height === '24px', `${theme}: consistent switch geometry`);
    for (const fixture of panel.querySelectorAll<HTMLElement>('[data-settings-layout]')) {
      const bounds = fixture.getBoundingClientRect();
      const tracks = [...fixture.querySelectorAll<HTMLElement>('[role="switch"] > [aria-hidden="true"]')];
      check(tracks.length === 3, `${theme}: grouped switch fixtures present at ${bounds.width}px`);
      check(tracks.every(item => Math.abs(bounds.right - item.getBoundingClientRect().right - 16) < 0.2),
        `${theme}: boxed, plain and nested switch columns align at ${bounds.width}px`);
      check(tracks.every(item => Math.abs(item.getBoundingClientRect().width - 44) < 0.2 && Math.abs(item.getBoundingClientRect().height - 24) < 0.2),
        `${theme}: grouped switch sizes match at ${bounds.width}px`);
      check(fixture.scrollWidth <= fixture.clientWidth, `${theme}: wrapped setting labels fit at ${bounds.width}px`);
    }
    for (const fixture of panel.querySelectorAll<HTMLButtonElement>('[data-switch-geometry]')) {
      const fixtureTrack = fixture.querySelector<HTMLElement>('[aria-hidden="true"]')!;
      const thumb = fixtureTrack.firstElementChild as HTMLElement;
      const outer = fixtureTrack.getBoundingClientRect();
      const inner = thumb.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(thumb).top);
      const name = fixture.getAttribute('aria-label');
      check(inner.width > 0 && Math.abs(inner.width - inner.height) < 0.2, `${name}: circular thumb`);
      check(Math.abs(inner.top - outer.top - inset) < 0.2 && Math.abs(outer.bottom - inner.bottom - inset) < 0.2, `${name}: vertically centered and contained`);
      const endGap = fixture.getAttribute('aria-checked') === 'true' ? outer.right - inner.right : inner.left - outer.left;
      check(Math.abs(endGap - inset) < 0.2, `${name}: equal end inset`);
    }
    check(loading.disabled && loading.getAttribute('aria-busy') === 'true', `${theme}: loading semantics`);
    let clicks = 0;
    const onClick = () => { clicks++; };
    loading.addEventListener('click', onClick);
    loading.click();
    loading.removeEventListener('click', onClick);
    check(clicks === 0, `${theme}: loading blocks native click`);
    check(invalid.getAttribute('aria-invalid') === 'true', `${theme}: validation state`);
    check((invalid.getAttribute('aria-describedby') ?? '').split(' ').every(id => document.getElementById(id)), `${theme}: description targets exist`);
    input.focus();
    check(document.activeElement === input, `${theme}: input focus`);
    const primary = panel.querySelector<HTMLButtonElement>('[data-primary]')!;
    const before = getComputedStyle(primary).backgroundColor;
    // Disable transitions while observing a live subtree theme override.
    const previousTransition = primary.style.transition;
    try {
      primary.style.transition = 'none';
      panel.style.setProperty('--color-app-accent', '#123456');
      check(getComputedStyle(primary).backgroundColor === 'rgb(18, 52, 86)', `${theme}: live scoped theme color`);
      panel.style.removeProperty('--color-app-accent');
      check(getComputedStyle(primary).backgroundColor === before, `${theme}: theme restoration`);
    } finally {
      panel.style.removeProperty('--color-app-accent');
      primary.style.transition = previousTransition;
    }
  }
  return results;
}

function Gallery() {
  const [results, setResults] = useState('Ready. Run checks, then inspect keyboard focus and visual states.');
  return <main className="control-gallery">
    <header>
      <h1>Zync control foundation</h1>
      <p>Development gallery · Controls, panel headers and action rows · No application data is accessed.</p>
      <Button type="button" onClick={() => {
        try { setResults(runChecks().join('\n')); }
        catch (error) { setResults(`FAIL ${error instanceof Error ? error.message : String(error)}`); }
      }}>Run browser checks</Button>
      <p role="status">{results.startsWith('PASS') ? `All ${results.split('\n').length} browser checks passed.` : results}</p>
      <details><summary>Check details</summary><pre data-check-results>{results}</pre></details>
    </header>
    <div className="control-gallery-grid"><ControlExamples theme="dark" /><ControlExamples theme="light" /></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Gallery />);
