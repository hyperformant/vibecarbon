import {
  IconActivity as Activity,
  IconCheck as Check,
  IconCloud as Cloud,
  IconCopy as Copy,
  IconDatabase as Database,
  IconFileCode as FileCode,
  IconFolder as Folder,
  IconFolderOpen as FolderOpen,
  IconWorld as Globe,
  IconStack2 as Layers,
  IconServer as Server,
  IconTerminal2 as Terminal,
  IconBolt as Zap,
} from '@tabler/icons-react';
import { motion, useInView } from 'framer-motion';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import logoIcon from '../assets/logo-icon.svg';

// Clean command box with prominent copy button
export function CommandBox({
  command,
  description,
  delay = 0,
}: {
  command: string;
  description?: string;
  delay?: number;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
      className="group"
    >
      {description && <p className="text-sm text-muted-foreground mb-2 ml-1">{description}</p>}
      <div className="relative flex items-center bg-muted/80 dark:bg-black/40 border border-border dark:border-white/10 rounded-xl overflow-hidden hover:border-primary/30 transition-colors">
        <div className="flex-1 flex items-center gap-3 px-5 py-4 font-mono text-sm md:text-base">
          <span className="text-primary font-bold">$</span>
          <span className="text-foreground">{command}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-2 px-5 self-stretch bg-black/[0.03] hover:bg-black/[0.06] dark:bg-white/5 dark:hover:bg-white/10 border-l border-border dark:border-white/10 transition-all cursor-pointer"
          aria-label="Copy command"
        >
          {copied ? (
            <>
              <Check className="w-4 h-4 text-primary" />
              <span className="text-xs text-primary font-medium hidden sm:inline">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              <span className="text-xs text-muted-foreground group-hover:text-foreground font-medium hidden sm:inline transition-colors">
                Copy
              </span>
            </>
          )}
        </button>
      </div>
    </motion.div>
  );
}

// Step number indicator
function StepNumber({ number, color }: { number: number; color: 'teal' | 'magenta' }) {
  return (
    <div
      className={`flex items-center justify-center w-12 h-12 rounded-2xl text-2xl font-black ${
        color === 'teal'
          ? 'bg-primary/20 text-primary border border-primary/30'
          : 'bg-secondary-accent/20 text-secondary-accent border border-secondary-accent/30'
      }`}
      style={{
        boxShadow:
          color === 'teal'
            ? '0 0 20px oklch(0.82 0.14 192 / 0.25)'
            : '0 0 20px oklch(0.65 0.26 350 / 0.25)',
      }}
    >
      {number}
    </div>
  );
}

// Create Visual: Project scaffolding animation
function CreateVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });

  const structure = [
    { name: 'my-app/', icon: FolderOpen, level: 0, delay: 0.2 },
    { name: 'src/', icon: Folder, level: 1, delay: 0.3 },
    { name: 'supabase/', icon: Folder, level: 1, delay: 0.4 },
    { name: 'k8s/', icon: Folder, level: 1, delay: 0.5 },
    { name: 'docker-compose.yml', icon: Layers, level: 1, delay: 0.6 },
    { name: 'package.json', icon: FileCode, level: 1, delay: 0.7 },
  ];

  return (
    <div ref={ref} className="relative h-full">
      {/* Behind-card glow */}
      <div className="absolute -inset-[40px] -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 50% 60%, rgb(0, 180, 200) 0%, rgb(0, 100, 140) 25%, rgba(0, 130, 160, 0) 65%)',
            filter: 'blur(50px)',
            opacity: 0.4,
          }}
        />
        <div
          className="absolute inset-[20%]"
          style={{
            background:
              'radial-gradient(ellipse 80% 70% at 50% 55%, rgb(100, 255, 240) 0%, rgba(0, 200, 210, 0) 60%)',
            filter: 'blur(30px)',
            opacity: 0.2,
          }}
        />
      </div>

      <div className="relative h-full flex flex-col bg-muted dark:bg-black/60 backdrop-blur-xl border border-border dark:border-white/10 rounded-2xl overflow-hidden">
        {/* Glowing top edge */}
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
        {/* Spotlight from above */}
        <div
          className="absolute inset-x-0 top-0 h-[250px] pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, oklch(0.82 0.14 192 / 0.25) 0%, transparent 100%)',
          }}
        />
        {/* Particle dots */}
        <div className="spotlight-particles absolute inset-0 pointer-events-none opacity-50" />

        {/* Terminal header */}
        <div className="relative flex items-center gap-2 px-4 py-3 border-b border-border dark:border-white/10 bg-black/[0.03] dark:bg-white/5">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
          </div>
          <span className="text-xs text-muted-foreground ml-2 font-mono">Terminal</span>
        </div>

        <div className="relative p-5 flex-1 flex flex-col">
          {/* Command */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
            className="font-mono text-sm mb-4 flex items-center gap-2"
          >
            <span className="text-primary">$</span>
            <span className="text-foreground">npx vibecarbon create</span>
          </motion.div>

          {/* File structure */}
          <div className="space-y-0.5 font-mono text-sm">
            {structure.map((item) => (
              <motion.div
                key={item.name}
                initial={{ opacity: 0, x: -20 }}
                animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
                transition={{ duration: 0.3, delay: item.delay }}
                className="flex items-center gap-2"
                style={{ paddingLeft: `${item.level * 20}px` }}
              >
                <item.icon
                  className={`w-4 h-4 flex-shrink-0 ${
                    item.name.endsWith('/') ? 'text-primary' : 'text-secondary-accent'
                  }`}
                />
                <span className="text-foreground/80">{item.name}</span>
              </motion.div>
            ))}
          </div>

          {/* Bottom-pins the success line when the card is stretched to the
              shared row height (lg subgrid) — collapses to nothing when the
              card is its natural height (mobile). */}
          <div className="flex-1" />

          {/* Success */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={{ duration: 0.4, delay: 0.9 }}
            className="mt-4 pt-4 border-t border-border dark:border-white/10 flex items-center gap-2"
          >
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-green-600 dark:text-green-400 text-sm font-medium">
              Project created successfully
            </span>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// Build Visual: Dev environment running
function BuildVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });

  const services = [
    { name: 'Vite', port: '5173', status: 'ready', icon: Zap, color: 'text-secondary-accent' },
    { name: 'API', port: '3000', status: 'ready', icon: Server, color: 'text-primary' },
    { name: 'Supabase', port: '8000', status: 'ready', icon: Database, color: 'text-green-400' },
    { name: 'Studio', port: '3001', status: 'ready', icon: Globe, color: 'text-blue-400' },
  ];

  return (
    <div ref={ref} className="relative h-full">
      {/* Behind-card glow */}
      <div className="absolute -inset-[40px] -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 50% 60%, rgb(200, 60, 180) 0%, rgb(140, 30, 120) 25%, rgba(160, 40, 140, 0) 65%)',
            filter: 'blur(50px)',
            opacity: 0.35,
          }}
        />
        <div
          className="absolute inset-[20%]"
          style={{
            background:
              'radial-gradient(ellipse 80% 70% at 50% 55%, rgb(255, 140, 220) 0%, rgba(200, 60, 180, 0) 60%)',
            filter: 'blur(30px)',
            opacity: 0.15,
          }}
        />
      </div>

      <div className="relative h-full flex flex-col bg-muted dark:bg-black/60 backdrop-blur-xl border border-border dark:border-white/10 rounded-2xl overflow-hidden">
        {/* Glowing top edge */}
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-secondary-accent/80 to-transparent" />
        {/* Spotlight from above */}
        <div
          className="absolute inset-x-0 top-0 h-[250px] pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, oklch(0.65 0.26 350 / 0.25) 0%, transparent 100%)',
          }}
        />
        {/* Particle dots */}
        <div className="spotlight-particles absolute inset-0 pointer-events-none opacity-50" />

        {/* Header */}
        <div className="relative flex items-center justify-between px-4 py-3 border-b border-border dark:border-white/10 bg-black/[0.03] dark:bg-white/5">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-secondary-accent" />
            <span className="text-xs text-muted-foreground font-mono">Development Server</span>
          </div>
          <div className="flex items-center gap-2">
            <Activity className="w-3 h-3 text-green-600 dark:text-green-400 animate-pulse" />
            <span className="text-xs text-green-600 dark:text-green-400">Running</span>
          </div>
        </div>

        <div className="relative p-5 space-y-3 flex-1 flex flex-col">
          {services.map((service, index) => (
            <motion.div
              key={service.name}
              initial={{ opacity: 0, x: -20 }}
              animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
              transition={{ duration: 0.4, delay: 0.2 + index * 0.15 }}
              className="flex items-center justify-between p-3 bg-black/[0.03] dark:bg-white/5 rounded-xl border border-border/50 dark:border-white/5"
            >
              <div className="flex items-center gap-3">
                <service.icon className={`w-5 h-5 ${service.color}`} />
                <span className="text-foreground font-medium">{service.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground font-mono text-sm">:{service.port}</span>
                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-xs text-green-600 dark:text-green-400">
                    {service.status}
                  </span>
                </div>
              </div>
            </motion.div>
          ))}

          {/* Bottom-pins the footer when the card is stretched to the shared
              row height (lg subgrid); no-op at natural height (mobile). */}
          <div className="flex-1" />

          {/* Hot reload indicator */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.4, delay: 0.9 }}
            className="pt-3 border-t border-border dark:border-white/10 flex items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Zap className="w-4 h-4 text-secondary-accent" />
            <span>
              Hot reload active at <span className="text-primary font-mono">localhost:5173</span>
            </span>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// Deploy Visual: Production infrastructure
function DeployVisual() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });

  return (
    <div ref={ref} className="relative h-full">
      {/* Behind-card glow */}
      <div className="absolute -inset-[40px] -z-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 50% 60%, rgb(0, 180, 200) 0%, rgb(0, 100, 140) 25%, rgba(0, 130, 160, 0) 65%)',
            filter: 'blur(50px)',
            opacity: 0.4,
          }}
        />
        <div
          className="absolute inset-[20%]"
          style={{
            background:
              'radial-gradient(ellipse 80% 70% at 50% 55%, rgb(100, 255, 240) 0%, rgba(0, 200, 210, 0) 60%)',
            filter: 'blur(30px)',
            opacity: 0.2,
          }}
        />
      </div>

      <div className="relative h-full flex flex-col bg-muted dark:bg-black/60 backdrop-blur-xl border border-border dark:border-white/10 rounded-2xl overflow-hidden">
        {/* Glowing top edge */}
        <div className="absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/80 to-transparent" />
        {/* Spotlight from above */}
        <div
          className="absolute inset-x-0 top-0 h-[250px] pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% 0%, oklch(0.82 0.14 192 / 0.25) 0%, transparent 100%)',
          }}
        />
        {/* Particle dots */}
        <div className="spotlight-particles absolute inset-0 pointer-events-none opacity-50" />

        {/* Header */}
        <div className="relative flex items-center justify-between px-4 py-3 border-b border-border dark:border-white/10 bg-black/[0.03] dark:bg-white/5">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground font-mono">
              Production Infrastructure
            </span>
          </div>
          <span className="text-xs text-primary font-medium">Kubernetes</span>
        </div>

        <div className="relative p-5 flex-1 flex flex-col">
          {/* Infrastructure diagram */}
          <div className="flex flex-col items-center gap-3">
            {/* Load Balancer */}
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: -20 }}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="w-full max-w-xs p-3 bg-gradient-to-r from-primary/20 to-primary/10 border border-primary/30 rounded-xl flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-primary" />
                <span className="font-medium text-sm">Load Balancer</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-xs text-foreground/70">Healthy</span>
              </div>
            </motion.div>

            {/* Connection line */}
            <motion.div
              initial={{ scaleY: 0 }}
              animate={isInView ? { scaleY: 1 } : { scaleY: 0 }}
              transition={{ duration: 0.2, delay: 0.4 }}
              className="w-px h-4 bg-gradient-to-b from-primary/50 to-secondary-accent/50 origin-top"
            />

            {/* App Pods */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={isInView ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.4, delay: 0.5 }}
              className="flex flex-wrap justify-center gap-2"
            >
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="p-2.5 bg-black/[0.03] dark:bg-white/5 border border-border/50 dark:border-white/10 rounded-lg flex items-center gap-2"
                >
                  <Server className="w-4 h-4 text-secondary-accent" />
                  <span className="text-xs font-mono">pod-{i}</span>
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                </div>
              ))}
            </motion.div>

            {/* Connection line */}
            <motion.div
              initial={{ scaleY: 0 }}
              animate={isInView ? { scaleY: 1 } : { scaleY: 0 }}
              transition={{ duration: 0.2, delay: 0.7 }}
              className="w-px h-4 bg-gradient-to-b from-secondary-accent/50 to-primary/50 origin-top"
            />

            {/* Database */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.4, delay: 0.8 }}
              className="w-full max-w-xs p-3 bg-gradient-to-r from-secondary-accent/20 to-secondary-accent/10 border border-secondary-accent/30 rounded-xl flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-secondary-accent" />
                <span className="font-medium text-sm">PostgreSQL HA</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-xs text-foreground/70">Primary</span>
              </div>
            </motion.div>
          </div>

          {/* Bottom-pins the status bar when the card is stretched to the
              shared row height (lg subgrid); no-op at natural height (mobile). */}
          <div className="flex-1" />

          {/* Status bar */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={isInView ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.4, delay: 1.0 }}
            className="mt-4 pt-4 border-t border-border dark:border-white/10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-muted-foreground">
                Autoscaling: <span className="text-primary">Active</span>
              </span>
              <span className="text-muted-foreground">
                High availability: <span className="text-primary">Ready</span>
              </span>
            </div>
            <span className="text-foreground/70 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              All systems operational
            </span>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// Workflow step column
function WorkflowStep({
  step,
  title,
  subtitle,
  command,
  visual,
  color,
}: {
  step: number;
  title: string;
  subtitle: string;
  command: string;
  visual: React.ReactNode;
  color: 'teal' | 'magenta';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-100px' });
  const delay = (step - 1) * 0.12;

  return (
    <div ref={ref} className="grid gap-6 lg:row-span-4 lg:grid-rows-subgrid">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
        transition={{ duration: 0.5, delay }}
        className="flex items-center gap-4"
      >
        <StepNumber number={step} color={color} />
        <h2
          className={`text-3xl md:text-4xl font-black tracking-tight ${
            color === 'teal' ? 'text-primary' : 'text-secondary-accent'
          }`}
        >
          {title}
        </h2>
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: 0.5, delay: delay + 0.1 }}
        className="text-base text-muted-foreground"
      >
        {subtitle}
      </motion.p>

      <CommandBox command={command} delay={delay + 0.2} />

      <div className="w-full">{visual}</div>
    </div>
  );
}

export function WorkflowSection() {
  const { t } = useTranslation();
  return (
    <section className="relative py-24 md:py-36 overflow-hidden">
      <div className="mx-auto max-w-7xl px-6">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-10"
        >
          <motion.div
            className="flex justify-center mb-6"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <img
              src={logoIcon}
              alt=""
              width={56}
              height={56}
              className="drop-shadow-[0_0_12px_oklch(0.82_0.14_192/0.6)]"
            />
          </motion.div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-4">
            {t('landing.workflow.headline')}
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {t('landing.workflow.subheading')}
          </p>
        </motion.div>

        {/* Steps — 3 columns on desktop (subgrid rows keep title/copy/command/visual
            aligned across columns), stacked on mobile */}
        <div className="grid gap-14 lg:grid-cols-3 lg:gap-x-8 lg:gap-y-6">
          <WorkflowStep
            step={1}
            title={t('landing.workflow.create.label')}
            subtitle={t('landing.workflow.create.description')}
            command="npx vibecarbon create"
            visual={<CreateVisual />}
            color="teal"
          />

          <WorkflowStep
            step={2}
            title={t('landing.workflow.develop.label')}
            subtitle={t('landing.workflow.develop.description')}
            command="npx vibecarbon up"
            visual={<BuildVisual />}
            color="magenta"
          />

          <WorkflowStep
            step={3}
            title={t('landing.workflow.deploy.label')}
            subtitle={t('landing.workflow.deploy.description')}
            command="npx vibecarbon deploy"
            visual={<DeployVisual />}
            color="teal"
          />
        </div>
      </div>
    </section>
  );
}
