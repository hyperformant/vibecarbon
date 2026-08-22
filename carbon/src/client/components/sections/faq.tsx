import type { ReactNode } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useDocsVisibility } from '@/hooks/api';

import { Section } from '../ui/section';

/*
 * FAQ section. Adapted from Launch UI (MIT) for Vite: points at the template's
 * own Base UI accordion (single-open by default — no Radix `type`/`collapsible`
 * props), next/link and siteConfig removed, and the copy genericized as a
 * starting point for the generated app.
 */

interface FAQItemProps {
  question: string;
  answer: ReactNode;
  value?: string;
  /**
   * Hide this entry when user documentation is turned off. For answers whose
   * subject is the docs themselves — an href filter cannot reach a link
   * embedded in prose, and an answer that only makes sense alongside a docs
   * site should go away with it rather than lose its link.
   */
  requiresUserDocs?: boolean;
}

interface FAQProps {
  title?: string;
  items?: FAQItemProps[] | false;
  className?: string;
}

const DEFAULT_FAQ_ITEMS: FAQItemProps[] = [
  {
    question: 'Do I own the code?',
    answer: (
      <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
        Yes. The generated application code is yours under the MIT license. The full source lives in
        your repository, and you can change, extend, or replace any part of it.
      </p>
    ),
  },
  {
    question: "What's the tech stack?",
    answer: (
      <>
        <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
          React 19, Vite, Tailwind CSS v4, and Shadcn UI on the front end, typed end to end.
        </p>
        <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
          Supabase handles data, auth, and storage; TanStack Query handles server state.
        </p>
      </>
    ),
  },
  {
    question: 'How does billing work?',
    answer: (
      <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
        Stripe handles checkout, subscriptions, invoices, and the customer portal. Plans are billed
        monthly, and customers change or cancel their own plan without going through you.
      </p>
    ),
  },
  {
    question: 'Where can I deploy it?',
    answer: (
      <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
        One CLI command deploys it to a supported cloud provider, as either a Docker Compose or a
        Kubernetes topology, with TLS and database backups configured as part of the deploy.
      </p>
    ),
  },
  {
    question: 'Is there documentation?',
    requiresUserDocs: true,
    answer: (
      <p className="text-muted-foreground mb-4 max-w-[640px] text-balance">
        Yes. Setup, configuration, and deployment are covered in the{' '}
        <a href="/docs" className="text-foreground underline">
          docs
        </a>
        , which ship with the app and are yours to edit.
      </p>
    ),
  },
];

export default function FAQ({
  title = 'Questions, answered.',
  items = DEFAULT_FAQ_ITEMS,
  className,
}: FAQProps) {
  const { userDocsEnabled } = useDocsVisibility();

  const visibleItems =
    items === false ? false : items.filter((item) => userDocsEnabled || !item.requiresUserDocs);

  return (
    <Section className={className}>
      <div className="max-w-container mx-auto flex flex-col items-center gap-8">
        <h2 className="text-center text-3xl font-semibold sm:text-5xl">{title}</h2>
        {visibleItems !== false && visibleItems.length > 0 && (
          <Accordion className="w-full max-w-[800px]">
            {visibleItems.map((item, index) => (
              <AccordionItem
                key={item.value ?? item.question}
                value={item.value || `item-${index + 1}`}
              >
                <AccordionTrigger>{item.question}</AccordionTrigger>
                <AccordionContent>{item.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </Section>
  );
}
