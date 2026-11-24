/**
 * Development control panel.
 *
 * The panel is built from the parameter schema and only talks to the renderer
 * through `onChange`. It can be dropped on any page without touching the
 * rendering code.
 */

import {
  ADVANCED_CONTROLS,
  DEFAULT_PARAMETERS,
  PALETTES,
  PRIMARY_CONTROLS,
  cloneParameters,
  formatParameter,
  normalizeParameters,
  parseParameters,
  serializeParameters,
  type BooleanParameter,
  type NebulaParameters,
  type PaletteId,
  type RangeControl,
} from '../simulation/Parameters';
import { PRESETS, applyPreset, detectPreset, presetById } from '../simulation/Presets';
import { randomSeed } from '../utils/Random';

export interface ControlsOptions {
  parameters: NebulaParameters;
  onChange: (parameters: NebulaParameters) => void;
  onNotice?: (message: string) => void;
  volumeAvailable?: boolean;
  /** Serialize the current look for export. Defaults to the legacy parameter envelope. */
  onExport?: (parameters: NebulaParameters) => string;
  /** Parse an imported document and apply it. Defaults to the legacy parameter parser. */
  onImport?: (text: string) => NebulaParameters;
}

interface RangeBinding {
  control: RangeControl;
  input: HTMLInputElement;
  output: HTMLSpanElement;
}

function hexToRgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Controls {
  private readonly root: HTMLElement;
  private readonly onChange: (parameters: NebulaParameters) => void;
  private readonly onNotice: (message: string) => void;
  private readonly onExport: ((parameters: NebulaParameters) => string) | null;
  private readonly onImport: ((text: string) => NebulaParameters) | null;

  private parameters: NebulaParameters;
  private volumeAvailable: boolean;

  private readonly ranges: RangeBinding[] = [];
  private seedInput!: HTMLInputElement;
  private presetSelect!: HTMLSelectElement;
  private paletteSelect!: HTMLSelectElement;
  private modeButtons: HTMLButtonElement[] = [];
  private toggles = new Map<BooleanParameter, HTMLInputElement>();
  private body!: HTMLElement;
  private collapseButton!: HTMLButtonElement;
  private fileInput!: HTMLInputElement;

  constructor(root: HTMLElement, options: ControlsOptions) {
    this.root = root;
    this.parameters = cloneParameters(options.parameters);
    this.onChange = options.onChange;
    this.onNotice = options.onNotice ?? (() => undefined);
    this.onExport = options.onExport ?? null;
    this.onImport = options.onImport ?? null;
    this.volumeAvailable = options.volumeAvailable ?? true;

    this.build();
    this.refresh();
  }

  // -------------------------------------------------------------------------
  // external updates
  // -------------------------------------------------------------------------

  setParameters(parameters: NebulaParameters): void {
    this.parameters = cloneParameters(parameters);
    this.refresh();
  }

  setVolumeAvailable(available: boolean): void {
    this.volumeAvailable = available;
    this.refreshMode();
  }

  // -------------------------------------------------------------------------
  // construction
  // -------------------------------------------------------------------------

  private build(): void {
    const head = element('div', 'controls-head');
    const title = element('div', 'controls-title');
    title.append(element('span', 'pulse'));
    title.append(document.createTextNode('Field parameters'));

    this.collapseButton = element('button', 'icon-btn', '–');
    this.collapseButton.type = 'button';
    this.collapseButton.title = 'Collapse panel';
    this.collapseButton.setAttribute('aria-label', 'Collapse panel');
    this.collapseButton.addEventListener('click', () => {
      const collapsed = this.root.classList.toggle('collapsed');
      this.collapseButton.textContent = collapsed ? '+' : '–';
      this.collapseButton.title = collapsed ? 'Expand panel' : 'Collapse panel';
    });

    head.append(title, this.collapseButton);

    this.body = element('div', 'controls-body');

    this.body.append(this.buildPresetField(), this.buildModeField(), this.buildSeedField());

    for (const control of PRIMARY_CONTROLS) {
      this.body.append(this.createRange(control));
    }

    this.body.append(this.buildPaletteField());

    const advanced = element('details');
    const summary = element('summary');
    summary.append(document.createTextNode('Advanced'));
    advanced.append(summary);
    for (const control of ADVANCED_CONTROLS) {
      advanced.append(this.createRange(control));
    }
    advanced.append(
      this.createToggle('paused', 'Freeze time'),
      this.createToggle('adaptiveQuality', 'Adaptive quality'),
    );
    this.body.append(advanced);

    const actions = element('div', 'btn-row');
    actions.style.marginTop = '14px';
    const reseed = element('button', 'btn accent', 'New seed');
    reseed.type = 'button';
    reseed.addEventListener('click', () => {
      this.parameters.seed = randomSeed();
      this.refresh();
      this.commit();
      this.onNotice('New seed');
    });
    const reset = element('button', 'btn', 'Reset');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.parameters = { ...DEFAULT_PARAMETERS };
      this.refresh();
      this.commit();
      this.onNotice('Defaults restored');
    });
    actions.append(reseed, reset);
    this.body.append(actions);

    const io = element('div', 'btn-row');
    io.style.marginTop = '6px';
    const exportButton = element('button', 'btn', 'Export JSON');
    exportButton.type = 'button';
    exportButton.addEventListener('click', () => this.exportJson());
    const importButton = element('button', 'btn', 'Import JSON');
    importButton.type = 'button';
    importButton.addEventListener('click', () => this.fileInput.click());
    io.append(exportButton, importButton);
    this.body.append(io);

    this.fileInput = element('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'application/json,.json';
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => this.importJson());
    this.body.append(this.fileInput);

    const hint = element('p', 'hint', 'space freeze · R new seed · seeded output is reproducible');
    this.body.append(hint);

    this.root.append(head, this.body);
  }

  private buildPresetField(): HTMLElement {
    const field = element('div', 'field');
    const label = element('label', 'field-label', 'Preset');
    label.htmlFor = 'nebula-preset';

    this.presetSelect = element('select');
    this.presetSelect.id = 'nebula-preset';
    for (const preset of PRESETS) {
      const option = element('option', undefined, preset.label);
      option.value = preset.id;
      option.title = preset.note;
      this.presetSelect.append(option);
    }
    const custom = element('option', undefined, 'Custom');
    custom.value = 'custom';
    this.presetSelect.append(custom);

    this.presetSelect.addEventListener('change', () => {
      const preset = presetById(this.presetSelect.value);
      if (!preset) return;
      this.parameters = applyPreset(this.parameters, preset);
      this.refresh();
      this.commit();
      this.onNotice(preset.label);
    });

    field.append(label, this.presetSelect);
    return field;
  }

  private buildModeField(): HTMLElement {
    const field = element('div', 'field');
    field.append(element('div', 'field-label', 'Renderer'));

    const segmented = element('div', 'segmented');
    segmented.setAttribute('role', 'group');
    segmented.setAttribute('aria-label', 'Renderer mode');

    const modes: Array<{ mode: '2d' | 'volume'; label: string; title: string }> = [
      { mode: '2d', label: '2D field', title: 'Screen-space density field' },
      { mode: 'volume', label: '3D volume', title: 'Raymarched 3D density field (slower)' },
    ];

    for (const definition of modes) {
      const button = element('button', undefined, definition.label);
      button.type = 'button';
      button.title = definition.title;
      button.dataset.mode = definition.mode;
      button.addEventListener('click', () => {
        if (definition.mode === 'volume' && !this.volumeAvailable) {
          this.onNotice('Volume renderer unavailable on this device');
          return;
        }
        if (this.parameters.mode === definition.mode) return;
        this.parameters.mode = definition.mode;
        this.refreshMode();
        this.commit();
        this.onNotice(definition.mode === 'volume' ? 'Volumetric mode' : '2D field mode');
      });
      this.modeButtons.push(button);
      segmented.append(button);
    }

    field.append(segmented);
    return field;
  }

  private buildSeedField(): HTMLElement {
    const field = element('div', 'field');
    const head = element('div', 'field-head');
    const label = element('label', 'field-label', 'Seed');
    label.htmlFor = 'nebula-seed';
    const unit = element('span', 'field-value', 'integer');
    head.append(label, unit);

    const row = element('div');
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr auto';
    row.style.gap = '6px';

    this.seedInput = element('input');
    this.seedInput.id = 'nebula-seed';
    this.seedInput.type = 'number';
    this.seedInput.min = '1';
    this.seedInput.max = '999999';
    this.seedInput.step = '1';
    this.seedInput.addEventListener('change', () => {
      const value = Number(this.seedInput.value);
      this.parameters.seed = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
      this.parameters = normalizeParameters(this.parameters);
      this.refresh();
      this.commit();
    });

    const dice = element('button', 'btn', 'RND');
    dice.type = 'button';
    dice.title = 'Random seed';
    dice.addEventListener('click', () => {
      this.parameters.seed = randomSeed();
      this.refresh();
      this.commit();
      this.onNotice('New seed');
    });

    row.append(this.seedInput, dice);
    field.append(head, row);
    return field;
  }

  private buildPaletteField(): HTMLElement {
    const field = element('div', 'field');
    const label = element('label', 'field-label', 'Palette');
    label.htmlFor = 'nebula-palette';

    this.paletteSelect = element('select');
    this.paletteSelect.id = 'nebula-palette';
    for (const [id, definition] of Object.entries(PALETTES) as Array<
      [PaletteId, (typeof PALETTES)[PaletteId]]
    >) {
      const option = element('option', undefined, definition.label);
      option.value = id;
      this.paletteSelect.append(option);
    }
    this.paletteSelect.addEventListener('change', () => {
      this.parameters.palette = this.paletteSelect.value as PaletteId;
      this.applyAccent(this.parameters.palette);
      this.commit();
    });

    field.append(label, this.paletteSelect);
    return field;
  }

  private createRange(control: RangeControl): HTMLElement {
    const id = `nebula-${control.key}`;
    const field = element('div', 'field');
    const head = element('div', 'field-head');
    const label = element('label', 'field-label', control.label);
    label.htmlFor = id;
    const output = element('span', 'field-value');
    head.append(label, output);

    const input = element('input');
    input.id = id;
    input.type = 'range';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.setAttribute('aria-label', control.label);

    const binding: RangeBinding = { control, input, output };
    this.ranges.push(binding);

    input.addEventListener('input', () => {
      const value = Number(input.value);
      (this.parameters as unknown as Record<string, number>)[control.key] = value;
      this.updateRange(binding);
      this.markCustom();
      this.commit();
    });

    field.append(head, input);
    return field;
  }

  private createToggle(key: BooleanParameter, labelText: string): HTMLElement {
    const row = element('div', 'toggle-row');
    row.append(element('span', undefined, labelText));

    const switchLabel = element('label', 'switch');
    const input = element('input');
    input.type = 'checkbox';
    const track = element('i');
    switchLabel.append(input, track);
    row.append(switchLabel);

    input.addEventListener('change', () => {
      this.parameters[key] = input.checked;
      this.commit();
    });

    this.toggles.set(key, input);
    return row;
  }

  // -------------------------------------------------------------------------
  // state plumbing
  // -------------------------------------------------------------------------

  private updateRange(binding: RangeBinding): void {
    const value = (this.parameters as unknown as Record<string, number>)[binding.control.key] ?? 0;
    binding.output.textContent = formatParameter(binding.control, value);
    const span = binding.control.max - binding.control.min;
    const fill = span > 0 ? ((value - binding.control.min) / span) * 100 : 0;
    binding.input.style.setProperty('--fill', `${Math.max(0, Math.min(100, fill))}%`);
  }

  private refresh(): void {
    for (const binding of this.ranges) {
      const value = (this.parameters as unknown as Record<string, number>)[binding.control.key];
      binding.input.value = String(value);
      this.updateRange(binding);
    }

    this.seedInput.value = String(this.parameters.seed);
    this.paletteSelect.value = this.parameters.palette;
    this.presetSelect.value = detectPreset(this.parameters);

    for (const [key, input] of this.toggles) {
      input.checked = Boolean(this.parameters[key]);
    }

    this.refreshMode();
    this.applyAccent(this.parameters.palette);
  }

  private refreshMode(): void {
    for (const button of this.modeButtons) {
      const active = button.dataset.mode === this.parameters.mode;
      button.setAttribute('aria-pressed', String(active));
      if (button.dataset.mode === 'volume') {
        button.disabled = !this.volumeAvailable;
        button.style.opacity = this.volumeAvailable ? '1' : '0.4';
        button.style.cursor = this.volumeAvailable ? 'pointer' : 'not-allowed';
      }
    }
  }

  private applyAccent(palette: PaletteId): void {
    const accent = PALETTES[palette].accent;
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-soft', hexToRgba(accent, 0.22));
  }

  /** Slider edits may no longer match a preset; reflect that in the dropdown. */
  private markCustom(): void {
    const detected = detectPreset(this.parameters);
    this.presetSelect.value = detected;
  }

  private commit(): void {
    this.onChange(cloneParameters(this.parameters));
  }

  // -------------------------------------------------------------------------
  // JSON import / export
  // -------------------------------------------------------------------------

  private exportJson(): void {
    const text = this.onExport
      ? this.onExport(this.parameters)
      : serializeParameters(this.parameters);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = element('a');
    anchor.href = url;
    anchor.download = `nebula-seed-${this.parameters.seed}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.onNotice('Parameters exported');
  }

  private async importJson(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = this.onImport ? this.onImport(text) : parseParameters(text);
      this.parameters = cloneParameters(parsed);
      this.refresh();
      this.commit();
      this.onNotice('Parameters imported');
    } catch (error) {
      console.error(error);
      this.onNotice(
        error instanceof Error && error.name === 'ConfigError'
          ? `Import failed — ${error.message}`
          : 'Import failed — invalid JSON',
      );
    }
  }
}
