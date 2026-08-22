import {
  IconCircleCheck as CheckCircle,
  IconLoader2 as Loader2,
  IconSend as Send,
} from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Nav } from '@/components/Nav';
import { SEO } from '@/components/SEO';
import { SiteFooter } from '@/components/SiteFooter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiJson } from '@/lib/api';

interface ContactForm {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export function submitContactForm(form: ContactForm) {
  return apiJson('/api/v1/contact/submit', { method: 'POST', body: form }, 'Failed to submit');
}

export default function Contact() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');

  const submitMutation = useMutation({
    mutationFn: () => submitContactForm({ name, email, subject, message }),
    onSuccess: () => {
      setName('');
      setEmail('');
      setSubject('');
      setMessage('');
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <SEO title="Contact" description="Get in touch with us." />

      <div className="mx-auto max-w-xl px-6 pt-28 pb-24">
        {submitMutation.isSuccess ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12 text-center">
              <CheckCircle className="size-12 text-primary mb-4" />
              <h2 className="text-2xl font-bold mb-2">Message Sent</h2>
              <p className="text-muted-foreground mb-6">
                Thank you for reaching out. We'll get back to you as soon as possible.
              </p>
              <Button variant="outline" onClick={() => submitMutation.reset()}>
                Send Another Message
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Contact Us</CardTitle>
              <CardDescription>
                Have a question or feedback? Fill out the form below and we'll get back to you.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitMutation.mutate();
                }}
                className="space-y-4"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subject">Subject</Label>
                  <Input
                    id="subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="How can we help?"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="message">Message</Label>
                  <Textarea
                    id="message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Your message..."
                    rows={6}
                    required
                    minLength={10}
                  />
                </div>

                {/* Honeypot - hidden from users, filled by bots */}
                <div className="hidden" aria-hidden="true">
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" />
                </div>

                {submitMutation.error && (
                  <p className="text-sm text-destructive">{submitMutation.error.message}</p>
                )}

                <Button type="submit" className="w-full" disabled={submitMutation.isPending}>
                  {submitMutation.isPending ? (
                    <Loader2 className="size-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="size-4 mr-2" />
                  )}
                  Send Message
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>

      <SiteFooter />
    </div>
  );
}
