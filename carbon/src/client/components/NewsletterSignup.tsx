import { IconCircleCheck as CheckCircle, IconLoader2 as Loader2 } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface NewsletterSignupProps {
  className?: string;
  variant?: 'inline' | 'stacked';
  buttonText?: string;
}

/**
 * Newsletter signup form. Embeddable in landing pages, footers, or standalone.
 * Uses double opt-in (sends confirmation email).
 */
export function NewsletterSignup({
  className,
  variant = 'inline',
  buttonText,
}: NewsletterSignupProps) {
  const { t } = useTranslation();
  const resolvedButtonText = buttonText ?? t('landing.newsletter.button');
  const [email, setEmail] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/v1/newsletter/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to subscribe');
      }
      return response.json();
    },
    onSuccess: () => {
      setEmail('');
      setValidationError(null);
    },
  });

  const handleSubmit = () => {
    if (!email.trim()) {
      setValidationError(t('landing.newsletter.errorEmpty'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setValidationError(t('landing.newsletter.errorInvalid'));
      return;
    }
    setValidationError(null);
    subscribeMutation.mutate();
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (validationError) setValidationError(null);
  };

  const hasError = !!validationError || !!subscribeMutation.error;
  const errorMessage = validationError || subscribeMutation.error?.message;

  if (subscribeMutation.isSuccess) {
    return (
      <div className={`flex items-center gap-2 text-sm ${className || ''}`}>
        <CheckCircle className="size-4 text-primary" />
        <span className="text-muted-foreground">{t('landing.newsletter.success')}</span>
      </div>
    );
  }

  if (variant === 'stacked') {
    return (
      <div className={`space-y-2 ${className || ''}`}>
        <Input
          type="email"
          value={email}
          onChange={handleEmailChange}
          placeholder={t('landing.newsletter.placeholder')}
          className="bg-background"
          aria-invalid={hasError}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <Button
          onClick={handleSubmit}
          disabled={subscribeMutation.isPending}
          className="w-full"
          size="sm"
          sparkle
        >
          {subscribeMutation.isPending && <Loader2 className="size-3 mr-1 animate-spin" />}
          {resolvedButtonText}
        </Button>
        {hasError && (
          <p className="text-sm text-destructive text-center animate-in fade-in slide-in-from-top-1 duration-200">
            {errorMessage}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`flex w-full flex-col gap-2 sm:w-fit ${className || ''}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="email"
          value={email}
          onChange={handleEmailChange}
          placeholder={t('landing.newsletter.placeholder')}
          className="bg-background h-9 w-full min-w-0 sm:w-[300px]"
          aria-invalid={hasError}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />
        <Button
          onClick={handleSubmit}
          disabled={subscribeMutation.isPending}
          size="default"
          className="w-full sm:w-auto"
          sparkle
        >
          {subscribeMutation.isPending && <Loader2 className="size-3 mr-1 animate-spin" />}
          {resolvedButtonText}
        </Button>
      </div>
      {hasError && (
        <p className="text-sm text-destructive text-center animate-in fade-in slide-in-from-top-1 duration-200">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
