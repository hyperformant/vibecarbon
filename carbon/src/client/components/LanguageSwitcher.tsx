import { IconWorld as Globe } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { availableLanguages } from '@/lib/locales';

/**
 * Display names for language codes. An entry here is a label, not a switch:
 * what the switcher offers is whatever locale files the build actually
 * carries. A code with no entry falls back to showing the code itself, so a
 * locale file added without a label still works.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
};

interface LanguageSwitcherProps {
  className?: string;
}

/**
 * Language switcher dropdown, offering exactly the locales this build ships.
 * Persists selection to localStorage via i18next's LanguageDetector.
 *
 * Renders nothing on a single-language build, which is what makes the
 * English-only default need no flag: there is no second language to switch to,
 * so the control removes itself.
 */
export function LanguageSwitcher({ className }: LanguageSwitcherProps) {
  const { i18n } = useTranslation();

  const languages = availableLanguages;

  // Nothing to switch between on a single-language build.
  if (languages.length <= 1) return null;

  const currentLanguage = i18n.language?.split('-')[0] || 'en';
  const currentLabel = LANGUAGE_LABELS[currentLanguage] || currentLanguage;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`cursor-pointer inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-muted/30 px-3 h-8 text-sm font-medium hover:bg-muted/60 transition-colors ${className || ''}`}
      >
        <Globe className="size-4" />
        <span>{currentLabel}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {languages.map((code) => (
          <DropdownMenuItem
            key={code}
            onClick={() => i18n.changeLanguage(code)}
            className={code === currentLanguage ? 'bg-accent' : ''}
          >
            {LANGUAGE_LABELS[code] || code}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
