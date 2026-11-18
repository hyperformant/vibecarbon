// The bobbing logo mark above a landing section's heading. Brand artwork, so
// neither Shadcn nor Launch UI has a piece for it.
import { motion } from 'framer-motion';
import logoIcon from '../assets/logo-icon.svg';

export function FloatingLogoMark() {
  return (
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
  );
}
