import { useMotionValueEvent, useScroll } from 'framer-motion';
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

interface SectionBounds {
  top: number;
  bottom: number;
}

interface ScrollytellingContextValue {
  activeSection: string | null;
  registerSection: (id: string, top: number, bottom: number) => void;
  unregisterSection: (id: string) => void;
}

const ScrollytellingContext = createContext<ScrollytellingContextValue | null>(null);

interface ScrollytellingProviderProps {
  children: ReactNode;
}

/**
 * Provider for scrollytelling - tracks which section is in focus
 * Sections register/unregister themselves and get focus state
 */
export function ScrollytellingProvider({ children }: ScrollytellingProviderProps) {
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [sections, setSections] = useState<Map<string, SectionBounds>>(new Map());

  const { scrollY } = useScroll();

  useMotionValueEvent(scrollY, 'change', (latest) => {
    const viewportCenter = latest + window.innerHeight / 2;

    let closestSection: string | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const [id, bounds] of sections) {
      const sectionCenter = (bounds.top + bounds.bottom) / 2;
      const distance = Math.abs(viewportCenter - sectionCenter);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestSection = id;
      }
    }

    if (closestSection !== activeSection) {
      setActiveSection(closestSection);
    }
  });

  const registerSection = useCallback((id: string, top: number, bottom: number) => {
    setSections((prev) => {
      const next = new Map(prev);
      next.set(id, { top, bottom });
      return next;
    });
  }, []);

  const unregisterSection = useCallback((id: string) => {
    setSections((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return (
    <ScrollytellingContext.Provider value={{ activeSection, registerSection, unregisterSection }}>
      {children}
    </ScrollytellingContext.Provider>
  );
}

export function useScrollytelling() {
  const ctx = useContext(ScrollytellingContext);
  if (!ctx) {
    throw new Error('useScrollytelling must be used within ScrollytellingProvider');
  }
  return ctx;
}
