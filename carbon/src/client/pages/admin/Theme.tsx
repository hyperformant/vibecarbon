import { IconLoader2 as Loader2, IconMoon as Moon, IconSun as Sun } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ContentPanel } from '@/components/ContentPanel';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { apiJson } from '@/lib/api';
import { TAILWIND_COLORS } from '@/lib/tailwind-colors';
import { applyTheme, DEFAULT_THEME, resetTheme, type ThemeConfig } from '@/lib/theme';
import { cn } from '@/lib/utils';

type SlotKey =
  | 'gradientStart'
  | 'gradientEnd'
  | 'card'
  | 'primary'
  | 'primaryDim'
  | 'primaryForeground'
  | 'secondaryAccent'
  | 'secondaryAccentForeground'
  | 'destructive'
  | 'warning'
  | 'success';

type ActiveSlot = {
  mode: 'light' | 'dark';
  key: SlotKey;
} | null;

const LIGHT_SLOTS: { key: SlotKey; labelKey: string }[] = [
  { key: 'gradientStart', labelKey: 'theme.colorSlots.gradientStart' },
  { key: 'gradientEnd', labelKey: 'theme.colorSlots.gradientEnd' },
  { key: 'card', labelKey: 'theme.colorSlots.card' },
  { key: 'primary', labelKey: 'theme.colorSlots.primary' },
  { key: 'primaryDim', labelKey: 'theme.colorSlots.primaryDim' },
  { key: 'primaryForeground', labelKey: 'theme.colorSlots.primaryForeground' },
  { key: 'secondaryAccent', labelKey: 'theme.colorSlots.secondaryAccent' },
  { key: 'destructive', labelKey: 'theme.colorSlots.destructive' },
  { key: 'warning', labelKey: 'theme.colorSlots.warning' },
  { key: 'success', labelKey: 'theme.colorSlots.success' },
];

const DARK_SLOTS: { key: SlotKey; labelKey: string }[] = [
  { key: 'gradientStart', labelKey: 'theme.colorSlots.gradientStart' },
  { key: 'gradientEnd', labelKey: 'theme.colorSlots.gradientEnd' },
  { key: 'card', labelKey: 'theme.colorSlots.card' },
  { key: 'primary', labelKey: 'theme.colorSlots.primary' },
  { key: 'primaryDim', labelKey: 'theme.colorSlots.primaryDim' },
  { key: 'primaryForeground', labelKey: 'theme.colorSlots.primaryForeground' },
  { key: 'secondaryAccent', labelKey: 'theme.colorSlots.secondaryAccent' },
];

const RADIUS_PRESETS = [
  { value: '0rem', label: 'Sharp' },
  { value: '0.25rem', label: '0.25rem' },
  { value: '0.5rem', label: '0.5rem' },
  { value: '0.625rem', label: '0.625rem (Default)' },
  { value: '0.75rem', label: '0.75rem' },
  { value: '1rem', label: '1rem' },
];

const themeQueryKey = ['admin', 'theme'];

function colorToHex(value: string): string {
  if (value.startsWith('#')) return value;
  // Use the browser's CSS engine to resolve oklch/etc to rgb
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return '#888888';
  ctx.fillStyle = value;
  return ctx.fillStyle; // returns hex string like "#rrggbb"
}

export default function AdminTheme() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  const [localTheme, setLocalTheme] = useState<ThemeConfig>(DEFAULT_THEME);
  const [activeSlot, setActiveSlot] = useState<ActiveSlot>(null);
  const [hexInput, setHexInput] = useState('');
  const editingMode = resolvedTheme === 'dark' ? 'dark' : 'light';
  const currentSlots = editingMode === 'light' ? LIGHT_SLOTS : DARK_SLOTS;

  const { data: fetchedTheme, isLoading } = useQuery<
    { theme: Partial<ThemeConfig> },
    Error,
    ThemeConfig
  >({
    queryKey: themeQueryKey,
    queryFn: () =>
      apiJson<{ theme: Partial<ThemeConfig> }>('/api/v1/admin/theme', {}, 'Failed to fetch theme'),
    refetchOnWindowFocus: false,
    select: (data) => {
      if (data?.theme && Object.keys(data.theme).length > 0) {
        return {
          light: { ...DEFAULT_THEME.light, ...data.theme.light },
          dark: { ...DEFAULT_THEME.dark, ...data.theme.dark },
          radius: data.theme.radius ?? DEFAULT_THEME.radius,
          smoothScrollEnabled: data.theme.smoothScrollEnabled ?? DEFAULT_THEME.smoothScrollEnabled,
          smoothScrollIntensity:
            data.theme.smoothScrollIntensity ?? DEFAULT_THEME.smoothScrollIntensity,
        };
      }
      return DEFAULT_THEME;
    },
  });

  // Sync fetched theme to local state on load
  useEffect(() => {
    if (fetchedTheme) {
      setLocalTheme(fetchedTheme);
      applyTheme(fetchedTheme);
    }
  }, [fetchedTheme]);

  // Live preview on every local theme change
  useEffect(() => {
    applyTheme(localTheme);
  }, [localTheme]);

  // Clear active slot when switching theme mode so it doesn't reference the wrong mode
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally resets only when editingMode changes
  useEffect(() => {
    setActiveSlot(null);
  }, [editingMode]);

  // Track whether initial data has loaded to avoid auto-saving defaults
  const initialized = useRef(false);
  useEffect(() => {
    if (fetchedTheme) initialized.current = true;
  }, [fetchedTheme]);

  const saveMutation = useMutation({
    mutationFn: (theme: ThemeConfig) =>
      apiJson<{ theme: Partial<ThemeConfig> }>(
        '/api/v1/admin/theme',
        { method: 'PATCH', body: { theme } },
        'Failed to save theme'
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: themeQueryKey });
    },
    onError: () => {
      toast.error(t('theme.saveFailed'));
    },
  });

  // Auto-save with debounce after user changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: saveMutation.mutate is stable, only re-run on localTheme changes
  useEffect(() => {
    if (!initialized.current) return;
    const timer = setTimeout(() => {
      saveMutation.mutate(localTheme);
    }, 500);
    return () => clearTimeout(timer);
  }, [localTheme]);

  const handleSlotClick = (mode: 'light' | 'dark', key: SlotKey) => {
    setActiveSlot({ mode, key });
    const currentValue =
      mode === 'light'
        ? localTheme.light[key as keyof typeof localTheme.light]
        : localTheme.dark[key as keyof typeof localTheme.dark];
    if (currentValue) {
      setHexInput(colorToHex(currentValue));
    }
  };

  const updateSlotColor = (color: string) => {
    if (!activeSlot) return;
    const { mode, key } = activeSlot;

    setLocalTheme((prev) => ({
      ...prev,
      [mode]: {
        ...prev[mode],
        [key]: color,
      },
    }));
    setHexInput(color.startsWith('#') ? color : colorToHex(color));
  };

  const handleHexChange = (hex: string) => {
    setHexInput(hex);
    // Only update theme if it's a valid hex color
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      updateSlotColor(hex);
    }
  };

  const handleColorInputChange = (hex: string) => {
    setHexInput(hex);
    updateSlotColor(hex);
  };

  const handleReset = () => {
    resetTheme();
    setLocalTheme(DEFAULT_THEME);
    setActiveSlot(null);
  };

  const getSlotValue = (mode: 'light' | 'dark', key: SlotKey): string => {
    if (mode === 'light') {
      return localTheme.light[key as keyof typeof localTheme.light] ?? '';
    }
    return (localTheme.dark[key as keyof typeof localTheme.dark] as string) ?? '';
  };

  if (isLoading) {
    return (
      <>
        <PageHeader title={t('theme.title')} description={t('theme.description')} />
        <ContentPanel variant="wide">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        </ContentPanel>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('theme.title')} description={t('theme.description')} />

      <ContentPanel variant="wide">
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          {/* Left Column - Color Slots */}
          <div className="space-y-6">
            {/* Colors - combined light/dark with theme toggle */}
            <Card>
              <CardHeader>
                <CardTitle>
                  {editingMode === 'light' ? t('theme.lightMode') : t('theme.darkMode')}
                </CardTitle>
                <CardAction>
                  <button
                    type="button"
                    onClick={() => setTheme(editingMode === 'dark' ? 'light' : 'dark')}
                    className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {editingMode === 'dark' ? (
                      <>
                        <Moon className="size-3.5" />
                        {t('theme.darkMode')}
                      </>
                    ) : (
                      <>
                        <Sun className="size-3.5" />
                        {t('theme.lightMode')}
                      </>
                    )}
                  </button>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-1">
                {currentSlots.map(({ key, labelKey }) => {
                  const value = getSlotValue(editingMode, key);
                  const isActive = activeSlot?.mode === editingMode && activeSlot?.key === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleSlotClick(editingMode, key)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
                        isActive && 'bg-accent ring-1 ring-primary'
                      )}
                    >
                      <div
                        className="size-4 shrink-0 rounded border border-border"
                        style={{ backgroundColor: value }}
                      />
                      <span className="flex-1 font-medium">{t(labelKey)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground font-mono">
                        {value}
                      </span>
                    </button>
                  );
                })}
              </CardContent>
            </Card>

            {/* Border Radius */}
            <Card>
              <CardHeader>
                <CardTitle>{t('theme.borderRadius')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Select
                  value={localTheme.radius}
                  onValueChange={(value) => {
                    if (!value) return;
                    setLocalTheme((prev) => ({ ...prev, radius: value }));
                  }}
                >
                  <SelectTrigger className="w-full">
                    <span>
                      {RADIUS_PRESETS.find((p) => p.value === localTheme.radius)?.label ??
                        localTheme.radius}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {RADIUS_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {preset.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>
            {/* Smooth Scrolling */}
            <Card>
              <CardHeader>
                <CardTitle>{t('theme.smoothScrolling')}</CardTitle>
                <CardAction>
                  <Switch
                    checked={localTheme.smoothScrollEnabled}
                    onCheckedChange={(checked) => {
                      setLocalTheme((prev) => ({
                        ...prev,
                        smoothScrollEnabled: checked,
                      }));
                    }}
                  />
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('theme.smoothScrollIntensity')}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {t('theme.smoothScrollDuration', {
                      value: ((localTheme.smoothScrollIntensity / 100) * 2.0).toFixed(1),
                    })}
                  </span>
                </div>
                <Slider
                  value={[localTheme.smoothScrollIntensity]}
                  onValueChange={(value) => {
                    if (Array.isArray(value)) {
                      setLocalTheme((prev) => ({
                        ...prev,
                        smoothScrollIntensity: value[0],
                      }));
                    }
                  }}
                  min={0}
                  max={100}
                  step={5}
                  disabled={!localTheme.smoothScrollEnabled}
                />
              </CardContent>
            </Card>
            {/* Reset Button */}
            <Button variant="outline" onClick={handleReset}>
              {t('theme.resetToDefaults')}
            </Button>
          </div>

          {/* Right Column - Color Picker */}
          <div>
            {activeSlot ? (
              <Card className="sticky top-6">
                <CardHeader>
                  <CardTitle>
                    {t(
                      (activeSlot.mode === 'light' ? LIGHT_SLOTS : DARK_SLOTS).find(
                        (s) => s.key === activeSlot.key
                      )?.labelKey ?? ''
                    )}{' '}
                    ({activeSlot.mode === 'light' ? t('theme.lightMode') : t('theme.darkMode')})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Color swatch + hex input + native picker */}
                  <div className="flex items-center gap-3">
                    <div className="relative size-10 shrink-0">
                      <div
                        className="size-full rounded border border-border"
                        style={{
                          backgroundColor: getSlotValue(activeSlot.mode, activeSlot.key),
                        }}
                      />
                      <input
                        type="color"
                        value={hexInput.startsWith('#') ? hexInput : '#888888'}
                        onChange={(e) => handleColorInputChange(e.target.value)}
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                      />
                    </div>
                    <Input
                      value={hexInput}
                      onChange={(e) => handleHexChange(e.target.value)}
                      placeholder="#000000"
                      className="font-mono text-sm"
                    />
                  </div>

                  {/* Tailwind Colors Grid */}
                  <div>
                    <h3 className="mb-3 text-sm font-semibold">Tailwind Colors</h3>
                    <div className="space-y-2">
                      {TAILWIND_COLORS.map((family) => (
                        <div key={family.name} className="flex items-center gap-1.5">
                          <span className="w-16 shrink-0 text-xs text-muted-foreground capitalize">
                            {family.name}
                          </span>
                          <div className="flex gap-0.5">
                            {family.shades.map((shade) => {
                              const isSelected = hexInput.toLowerCase() === shade.hex.toLowerCase();
                              return (
                                <button
                                  key={shade.shade}
                                  type="button"
                                  title={`${shade.name} (${shade.hex})`}
                                  onClick={() => {
                                    updateSlotColor(shade.hex);
                                    setHexInput(shade.hex);
                                  }}
                                  className={cn(
                                    'size-5 shrink-0 rounded-sm border transition-transform hover:scale-125',
                                    isSelected
                                      ? 'ring-2 ring-primary ring-offset-1 ring-offset-background border-primary'
                                      : 'border-transparent'
                                  )}
                                  style={{ backgroundColor: shade.hex }}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  <p className="text-sm">Select a color slot on the left to start customizing.</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </ContentPanel>
    </>
  );
}
