import { useEffect, useRef, useState } from 'react';

/**
 * Mouse-tracking radial glow overlay for cards.
 *
 * Usage: Place as the first child of a `relative overflow-hidden` container.
 * The glow follows the cursor within the card and fades on mouse leave.
 */
export function GlowTracker() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;

    const handleMove = (e: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const handleEnter = () => setVisible(true);
    const handleLeave = () => setVisible(false);

    parent.addEventListener('mousemove', handleMove);
    parent.addEventListener('mouseenter', handleEnter);
    parent.addEventListener('mouseleave', handleLeave);
    return () => {
      parent.removeEventListener('mousemove', handleMove);
      parent.removeEventListener('mouseenter', handleEnter);
      parent.removeEventListener('mouseleave', handleLeave);
    };
  }, []);

  return (
    <div ref={ref} className="absolute inset-0 z-0 pointer-events-none">
      <div
        className="absolute -inset-px rounded-[inherit] transition-opacity duration-300"
        style={{
          opacity: visible ? 1 : 0,
          background: `radial-gradient(600px circle at ${pos.x}px ${pos.y}px, oklch(0.82 0.14 192 / 0.06) 0%, transparent 90%)`,
        }}
      />
    </div>
  );
}
