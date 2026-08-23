import {
  IconDots as MoreHorizontal,
  IconPlus as Plus,
  IconSettings as Settings,
  IconUsers as Users,
} from '@tabler/icons-react';
import { type ClassValue, clsx } from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { twMerge } from 'tailwind-merge';
import { Nav } from './Nav';
import { ShimmerBadge } from './ShimmerBadge';
import { CommandBox } from './WorkflowSection';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Animation phases for the CLI
type Phase =
  | 'typing'
  | 'intro'
  | 'projectName'
  | 'packageManager'
  | 'git'
  | 'config'
  | 'spinner'
  | 'success'
  | 'nextSteps'
  | 'outro';

// Clack-style CLI animation
const TerminalWindow = ({ onComplete }: { onComplete: () => void }) => {
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('typing');
  const [spinnerStep, setSpinnerStep] = useState(0);
  const [spinnerChar, setSpinnerChar] = useState(0);
  const [selectedPm, setSelectedPm] = useState(0);

  const command = 'vibecarbon create';
  const spinnerChars = ['◒', '◐', '◓', '◑'];
  const spinnerSteps = [
    'Creating project structure',
    'Generating configuration files',
    'Generating Docker configuration',
    'Generating backend files',
    'Installing dependencies with npm',
    'Initializing git repository',
  ];
  const pmOptions = ['npm', 'pnpm', 'bun'];

  // Typing animation
  useEffect(() => {
    if (phase !== 'typing') return;
    if (typed.length < command.length) {
      const timeout = setTimeout(
        () => {
          setTyped(command.slice(0, typed.length + 1));
        },
        30 + Math.random() * 20
      );
      return () => clearTimeout(timeout);
    }
    const timeout = setTimeout(() => setPhase('intro'), 400);
    return () => clearTimeout(timeout);
  }, [typed, phase]);

  // Phase progression
  useEffect(() => {
    if (phase === 'intro') {
      const timeout = setTimeout(() => setPhase('projectName'), 600);
      return () => clearTimeout(timeout);
    }
    if (phase === 'projectName') {
      const timeout = setTimeout(() => setPhase('packageManager'), 800);
      return () => clearTimeout(timeout);
    }
    if (phase === 'packageManager') {
      // Animate through package manager selection
      const selectTimeout = setTimeout(() => {
        setSelectedPm(0);
        setTimeout(() => setPhase('git'), 400);
      }, 600);
      return () => clearTimeout(selectTimeout);
    }
    if (phase === 'git') {
      const timeout = setTimeout(() => setPhase('config'), 600);
      return () => clearTimeout(timeout);
    }
    if (phase === 'config') {
      const timeout = setTimeout(() => setPhase('spinner'), 800);
      return () => clearTimeout(timeout);
    }
    if (phase === 'spinner') {
      if (spinnerStep < spinnerSteps.length) {
        const timeout = setTimeout(() => {
          setSpinnerStep((s) => s + 1);
        }, 350);
        return () => clearTimeout(timeout);
      }
      const timeout = setTimeout(() => setPhase('success'), 300);
      return () => clearTimeout(timeout);
    }
    if (phase === 'success') {
      const timeout = setTimeout(() => setPhase('nextSteps'), 400);
      return () => clearTimeout(timeout);
    }
    if (phase === 'nextSteps') {
      const timeout = setTimeout(() => setPhase('outro'), 600);
      return () => clearTimeout(timeout);
    }
    if (phase === 'outro') {
      const timeout = setTimeout(onComplete, 1200);
      return () => clearTimeout(timeout);
    }
  }, [phase, spinnerStep, onComplete, spinnerSteps.length]);

  // Spinner character animation
  useEffect(() => {
    if (phase !== 'spinner' || spinnerStep >= spinnerSteps.length) return;
    const interval = setInterval(() => {
      setSpinnerChar((c) => (c + 1) % 4);
    }, 80);
    return () => clearInterval(interval);
  }, [phase, spinnerStep, spinnerSteps.length]);

  const getPhaseIndex = (p: Phase) => {
    const phases: Phase[] = [
      'typing',
      'intro',
      'projectName',
      'packageManager',
      'git',
      'config',
      'spinner',
      'success',
      'nextSteps',
      'outro',
    ];
    return phases.indexOf(p);
  };

  const isPastPhase = (p: Phase) => getPhaseIndex(phase) > getPhaseIndex(p);
  const isAtOrPastPhase = (p: Phase) => getPhaseIndex(phase) >= getPhaseIndex(p);

  return (
    <div className="w-full h-full font-mono text-[13px] leading-relaxed p-4 flex flex-col overflow-hidden">
      {/* Terminal Header */}
      <div className="flex items-center justify-between mb-3 opacity-60">
        <div className="flex space-x-2">
          <div className="w-3 h-3 rounded-full bg-red-500/70" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <div className="w-3 h-3 rounded-full bg-green-500/70" />
        </div>
        <div className="text-xs text-muted-foreground">Terminal</div>
      </div>

      {/* CLI Content */}
      <div className="flex-1 overflow-hidden">
        {/* Command line */}
        <div className="flex items-center text-foreground">
          <span className="text-primary mr-2">$</span>
          <span>{typed}</span>
          {phase === 'typing' && typed.length < command.length && (
            <span className="w-2 h-4 bg-primary ml-0.5 animate-pulse" />
          )}
        </div>

        {/* Intro */}
        {isAtOrPastPhase('intro') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-2 text-muted-foreground"
          >
            <span className="text-secondary-accent">◆</span> vibecarbon create
          </motion.div>
        )}

        {/* Project name prompt */}
        {isAtOrPastPhase('projectName') && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1">
            <span className="text-muted-foreground/50">│</span>
            <div className="ml-2 inline">
              {isPastPhase('projectName') ? (
                <>
                  <span className="text-primary">◇</span>{' '}
                  <span className="text-muted-foreground">What is your project name?</span>{' '}
                  <span className="text-foreground">my-app</span>
                </>
              ) : (
                <>
                  <span className="text-primary">◆</span>{' '}
                  <span className="text-foreground">What is your project name?</span>
                  <span className="ml-2 text-muted-foreground">my-app</span>
                  <span className="w-2 h-4 bg-primary ml-0.5 inline-block animate-pulse align-middle" />
                </>
              )}
            </div>
          </motion.div>
        )}

        {/* Package manager select */}
        {isAtOrPastPhase('packageManager') && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1">
            <span className="text-muted-foreground/50">│</span>
            <div className="ml-2 inline">
              {isPastPhase('packageManager') ? (
                <>
                  <span className="text-primary">◇</span>{' '}
                  <span className="text-muted-foreground">Which package manager?</span>{' '}
                  <span className="text-foreground">npm</span>
                </>
              ) : (
                <>
                  <span className="text-primary">◆</span>{' '}
                  <span className="text-foreground">Which package manager?</span>
                  <div className="ml-4 mt-1 space-y-0.5">
                    {pmOptions.map((pm, i) => (
                      <div key={pm} className="flex items-center gap-2">
                        <span
                          className={i === selectedPm ? 'text-primary' : 'text-muted-foreground/50'}
                        >
                          {i === selectedPm ? '●' : '○'}
                        </span>
                        <span
                          className={i === selectedPm ? 'text-foreground' : 'text-muted-foreground'}
                        >
                          {pm}
                        </span>
                        {i === 0 && (
                          <span className="text-muted-foreground/50 text-xs">(recommended)</span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        )}

        {/* Git confirm */}
        {isAtOrPastPhase('git') && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1">
            <span className="text-muted-foreground/50">│</span>
            <div className="ml-2 inline">
              <span className="text-primary">◇</span>{' '}
              <span className="text-muted-foreground">Initialize a git repository?</span>{' '}
              <span className="text-foreground">Yes</span>
            </div>
          </motion.div>
        )}

        {/* Configuration box */}
        {isAtOrPastPhase('config') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-2 border border-border/40 rounded px-3 py-2 bg-muted/50 dark:bg-white/[0.02] text-xs"
          >
            <div className="text-muted-foreground mb-1.5">Configuration</div>
            <div className="space-y-0.5 text-foreground">
              <div>
                Project: <span className="text-muted-foreground">my-app</span>
              </div>
              <div>
                Package manager: <span className="text-muted-foreground">npm</span>
              </div>
              <div>
                Git: <span className="text-muted-foreground">yes</span>
              </div>
            </div>
          </motion.div>
        )}

        {/* Spinner steps */}
        {isAtOrPastPhase('spinner') && (
          <div className="mt-2 space-y-0.5">
            {spinnerSteps.map((step, i) => {
              if (i > spinnerStep) return null;
              const isComplete = i < spinnerStep;
              const isCurrent = i === spinnerStep && phase === 'spinner';
              return (
                <motion.div
                  key={step}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-2"
                >
                  {isComplete ? (
                    <span className="text-primary">✓</span>
                  ) : isCurrent ? (
                    <span className="text-primary">{spinnerChars[spinnerChar]}</span>
                  ) : (
                    <span className="text-primary">✓</span>
                  )}
                  <span className={isComplete ? 'text-muted-foreground' : 'text-foreground'}>
                    {step}
                  </span>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* Success */}
        {isAtOrPastPhase('success') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-2 text-primary"
          >
            <span>◇</span> Project created successfully
          </motion.div>
        )}

        {/* Next steps */}
        {isAtOrPastPhase('nextSteps') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-2 border border-border/40 rounded px-3 py-2 bg-muted/50 dark:bg-white/[0.02] text-xs"
          >
            <div className="text-muted-foreground mb-1">Next steps</div>
            <div className="text-foreground space-y-0.5">
              <div>cd my-app</div>
              <div>npm run dev:start</div>
            </div>
          </motion.div>
        )}

        {/* Outro */}
        {isAtOrPastPhase('outro') && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-2 text-muted-foreground"
          >
            <span className="text-secondary-accent">◇</span> Happy building!
          </motion.div>
        )}
      </div>
    </div>
  );
};

// SaaS Dashboard Preview
const DashboardPreview = () => {
  const projects = [
    { name: 'my-app', env: 'production', status: 'healthy', users: '1.2k' },
    { name: 'staging', env: 'staging', status: 'healthy', users: '45' },
  ];

  return (
    <div className="w-full h-full flex text-xs">
      {/* Sidebar */}
      <div className="w-14 border-r border-border/50 flex flex-col items-center py-3 gap-3 bg-black/5 dark:bg-black/20">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-background font-bold text-sm">
          C
        </div>
        <div className="flex-1 flex flex-col gap-2 mt-2">
          <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center text-primary">
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
          </div>
          <div className="w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-muted-foreground">
            <Users className="w-4 h-4" />
          </div>
          <div className="w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-muted-foreground">
            <Settings className="w-4 h-4" />
          </div>
        </div>
        <div className="w-7 h-7 rounded-full bg-secondary-accent/20 flex items-center justify-center text-secondary-accent text-[10px] font-medium">
          JD
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 p-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-foreground font-semibold text-sm">Projects</h2>
            <p className="text-muted-foreground text-[10px]">Manage your deployments</p>
          </div>
          <button
            type="button"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary text-white text-[10px] font-medium"
          >
            <Plus className="w-3 h-3" />
            New Project
          </button>
        </div>

        {/* Projects list */}
        <div className="space-y-2">
          {projects.map((project) => (
            <div
              key={project.name}
              className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-md bg-gradient-to-br from-primary/20 to-secondary-accent/20 flex items-center justify-center text-foreground font-medium text-[10px]">
                  {project.name[0].toUpperCase()}
                </div>
                <div>
                  <div className="text-foreground font-medium text-xs">{project.name}</div>
                  <div className="text-muted-foreground text-[10px]">{project.env}</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <div className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <span className="text-muted-foreground text-[10px]">{project.status}</span>
                  </div>
                  <div className="text-muted-foreground text-[10px]">{project.users} users</div>
                </div>
                <button
                  type="button"
                  className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                >
                  <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-3 gap-2 mt-4">
          {[
            { label: 'Total Users', value: '1,247', change: '+12%' },
            { label: 'API Calls', value: '847K', change: '+8%' },
            { label: 'Avg Latency', value: '24ms', change: '-5%' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="p-2.5 rounded-lg border border-border/50 bg-black/[0.02] dark:bg-white/[0.02]"
            >
              <div className="text-muted-foreground text-[10px]">{stat.label}</div>
              <div className="text-foreground font-semibold text-sm">{stat.value}</div>
              <div
                className={`text-[10px] ${stat.change.startsWith('+') ? 'text-green-400' : 'text-primary'}`}
              >
                {stat.change}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default function Hero() {
  const { t } = useTranslation();
  const [terminalComplete, setTerminalComplete] = useState(false);
  const [animationKey, setAnimationKey] = useState(0);

  const handleTerminalComplete = useCallback(() => {
    setTerminalComplete(true);
  }, []);

  useEffect(() => {
    if (terminalComplete) {
      const timeout = setTimeout(() => {
        setTerminalComplete(false);
        setAnimationKey((k) => k + 1);
      }, 6000);
      return () => clearTimeout(timeout);
    }
  }, [terminalComplete]);

  return (
    <div className="relative min-h-screen w-full bg-background text-foreground overflow-x-hidden selection:bg-primary/30">
      <Nav />

      <main className="relative z-10 flex flex-col items-center justify-center min-h-screen bg-canvas px-4 pt-32 pb-32">
        <div className="text-center max-w-4xl mx-auto mb-6 relative">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="flex items-center justify-center gap-3 select-none cursor-default mb-6"
          >
            <ShimmerBadge>{t('landing.hero.badge')}</ShimmerBadge>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1 }}
            className="text-4xl md:text-6xl lg:text-7xl font-black tracking-tight mb-6"
          >
            <span className="block text-foreground">{t('landing.hero.headline1')}</span>
            <span className="block text-primary pb-2">Vibecoding</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-6"
          >
            <span className="text-foreground/80">
              {(() => {
                const subheading = t('landing.hero.subheading');
                const [first, second] = subheading.split(/\.\s+/);
                if (second === undefined) return subheading;
                return (
                  <>
                    {first}.<br />
                    {second}
                  </>
                );
              })()}
            </span>
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="w-full max-w-md mx-auto mb-10"
        >
          <CommandBox command="npm install -g vibecarbon" />
        </motion.div>

        <div className="w-full max-w-3xl relative overflow-visible">
          {/* Ambient glow orb — 3 layers for depth */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -z-10 pointer-events-none">
            <div className="hero-orb w-[700px] h-[400px] rounded-full bg-primary/8 blur-[100px]" />
            <div className="absolute inset-[80px] rounded-full bg-primary/15 blur-[60px]" />
            <div className="absolute inset-[160px] rounded-full bg-primary/30 blur-[30px]" />
            <div className="absolute top-[40%] left-[20%] w-[200px] h-[200px] rounded-full bg-secondary-accent/10 blur-[80px]" />
          </div>

          <div className="h-[380px] relative">
            <motion.div
              initial={false}
              className={cn(
                'absolute inset-0 overflow-hidden border transition-colors duration-1000 rounded-2xl shadow-2xl backdrop-blur-md',
                terminalComplete ? 'bg-card/70 border-border' : 'bg-background/65 border-border/50'
              )}
            >
              {/* Glass spotlight from above */}
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent z-20" />
              <div
                className="absolute inset-x-0 top-0 h-[220px] pointer-events-none z-10"
                style={{
                  background:
                    'radial-gradient(ellipse 70% 55% at 50% 0%, oklch(0.82 0.14 192 / 0.30) 0%, transparent 100%)',
                }}
              />
              <div className="spotlight-particles absolute inset-0 pointer-events-none opacity-50 z-10" />

              <div className="absolute inset-0 bg-gradient-to-br from-black/5 dark:from-white/5 to-transparent pointer-events-none z-20 rounded-2xl" />

              <AnimatePresence mode="wait">
                {!terminalComplete ? (
                  <motion.div
                    key={`terminal-${animationKey}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, filter: 'blur(10px)' }}
                    transition={{ duration: 0.5 }}
                    className="h-full"
                  >
                    <TerminalWindow onComplete={handleTerminalComplete} />
                  </motion.div>
                ) : (
                  <motion.div
                    key={`dashboard-${animationKey}`}
                    initial={{ opacity: 0, scale: 0.95, filter: 'blur(10px)' }}
                    animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                    transition={{ duration: 0.8 }}
                    className="h-full"
                  >
                    <DashboardPreview />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>
        </div>
      </main>
    </div>
  );
}
