import { Nav } from '@/components/Nav';
import CTA from '@/components/sections/cta';
import FAQ from '@/components/sections/faq';
import Features from '@/components/sections/features';
import Footer from '@/components/sections/footer';
import Hero from '@/components/sections/hero';
import Pricing from '@/components/sections/pricing';

/*
 * Temporary preview of the Launch UI-based marketing homepage (embed in
 * progress). View at /home-preview. Sections are added here as they land;
 * once complete this replaces the current Home.
 */
export default function HomePreview() {
  return (
    <div className="bg-background min-h-screen">
      <Nav />
      <main className="pt-20">
        <Hero />
        <div id="features">
          <Features />
        </div>
        <div id="pricing">
          <Pricing />
        </div>
        <FAQ />
        <CTA />
        <Footer />
      </main>
    </div>
  );
}
