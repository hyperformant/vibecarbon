import { motion } from 'framer-motion';
import aiderLogo from '../assets/logos/aider.svg';
import antigravityLogo from '../assets/logos/antigravity.svg';
import boltLogo from '../assets/logos/bolt.svg';
import claudeLogo from '../assets/logos/claude-code.svg';
import copilotLogo from '../assets/logos/copilot.svg';
import cursorLogo from '../assets/logos/cursor.svg';
import geminiLogo from '../assets/logos/gemini-cli.svg';
import lovableLogo from '../assets/logos/lovable.svg';
import openaiLogo from '../assets/logos/openai-codex.svg';
import v0Logo from '../assets/logos/v0.svg';
import windsurfLogo from '../assets/logos/windsurf.svg';

const LOGO_ITEMS = [
  { src: claudeLogo, name: 'Claude Code', href: 'https://docs.anthropic.com/en/docs/claude-code' },
  { src: geminiLogo, name: 'Gemini CLI', href: 'https://github.com/google-gemini/gemini-cli' },
  { src: openaiLogo, name: 'OpenAI Codex', href: 'https://openai.com/codex/' },
  { src: antigravityLogo, name: 'Antigravity', href: 'https://antigravityai.org/' },
  { src: cursorLogo, name: 'Cursor', href: 'https://cursor.com' },
  { src: windsurfLogo, name: 'Windsurf', href: 'https://windsurf.com' },
  { src: boltLogo, name: 'Bolt', href: 'https://bolt.new' },
  { src: v0Logo, name: 'v0', href: 'https://v0.dev' },
  { src: lovableLogo, name: 'Lovable', href: 'https://lovable.dev' },
  { src: aiderLogo, name: 'Aider', href: 'https://aider.chat' },
  { src: copilotLogo, name: 'Copilot', href: 'https://github.com/features/copilot' },
];

export function LogoStrip() {
  return (
    <motion.section
      className="relative py-10 overflow-hidden"
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
    >
      <div className="max-w-7xl mx-auto">
        <div
          className="relative overflow-hidden"
          style={{
            maskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)',
          }}
        >
          <div className="marquee-track flex w-max">
            {[...LOGO_ITEMS, ...LOGO_ITEMS].map((item, i) => (
              <a
                // Marquee duplicates LOGO_ITEMS for the scroll loop, so the
                // stable key is `${item.name}-${copyIndex}` — `i` divided by
                // the original length tells us which copy we're on.
                key={`${item.name}-${i < LOGO_ITEMS.length ? 'a' : 'b'}`}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-2.5 px-8 shrink-0"
              >
                <img
                  src={item.src}
                  alt=""
                  style={{ height: 22, width: 'auto' }}
                  className="dark:brightness-0 dark:invert opacity-70 group-hover:brightness-100 group-hover:invert-0 group-hover:opacity-100 transition-all duration-300"
                />
                <span className="text-sm font-medium text-muted-foreground/70 group-hover:text-foreground whitespace-nowrap transition-colors duration-300">
                  {item.name}
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </motion.section>
  );
}
