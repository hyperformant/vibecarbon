import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';

import logoIcon from '../assets/logo-icon.svg';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';

export function FAQSection() {
  const { t } = useTranslation();

  const faqs = [
    { question: t('landing.faq.q1.question'), answer: t('landing.faq.q1.answer') },
    { question: t('landing.faq.q2.question'), answer: t('landing.faq.q2.answer') },
    { question: t('landing.faq.q3.question'), answer: t('landing.faq.q3.answer') },
    { question: t('landing.faq.q4.question'), answer: t('landing.faq.q4.answer') },
    { question: t('landing.faq.q5.question'), answer: t('landing.faq.q5.answer') },
    { question: t('landing.faq.q6.question'), answer: t('landing.faq.q6.answer') },
    { question: t('landing.faq.q7.question'), answer: t('landing.faq.q7.answer') },
    { question: t('landing.faq.q8.question'), answer: t('landing.faq.q8.answer') },
    { question: t('landing.faq.q9.question'), answer: t('landing.faq.q9.answer') },
  ];

  return (
    <section className="relative py-24 md:py-36">
      <div className="mx-auto max-w-3xl px-6">
        <div className="mb-8 text-center">
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

          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="text-3xl md:text-5xl font-black tracking-tight mb-4"
          >
            {t('landing.faq.headline')}
          </motion.h2>
          <p className="text-lg text-muted-foreground">{t('landing.faq.subheading')}</p>
        </div>

        <Accordion className="border-none rounded-none">
          {faqs.map((faq, index) => (
            <motion.div
              key={faq.question}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: index * 0.08 }}
            >
              <AccordionItem
                value={faq.question}
                className="border border-border bg-card/40 dark:border-white/8 dark:bg-white/[0.02] rounded-xl mb-3 overflow-hidden backdrop-blur-sm"
              >
                <AccordionTrigger>{faq.question}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-muted-foreground">{faq.answer}</p>
                </AccordionContent>
              </AccordionItem>
            </motion.div>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
