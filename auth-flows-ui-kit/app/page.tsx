import Link from "next/link"
import { ArrowRight, Shield, Fingerprint, Zap, Code2, Smartphone, Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FeatureTicker } from "@/components/marketing/feature-ticker"

const flows = [
  {
    title: "Sign Up",
    href: "/auth/signup",
    description: "Name, phone, email, password with confirm. Password strength meter, real-time match, phone auto-formatting, field-level errors.",
  },
  {
    title: "Login",
    href: "/auth/login",
    description: "Email and password with remember me. Forgot password link, OAuth providers, error summaries.",
  },
  {
    title: "Forgot Password",
    href: "/auth/forgot-password",
    description: "Email input with success state. Check-your-inbox confirmation with back-to-login link.",
  },
  {
    title: "Thank You",
    href: "/auth/thank-you",
    description: "Confetti celebration, pulsing success icon, email verification prompt, encryption badges.",
  },
]

const features = [
  {
    icon: Shield,
    title: "Accessible by default",
    detail: "aria-describedby, aria-invalid, error summaries with field links, role=\"alert\" and aria-live=\"polite\" for live announcements.",
  },
  {
    icon: Fingerprint,
    title: "Real validation",
    detail: "Password strength meter, real-time confirm match, phone auto-formatting, field-level and form-level errors.",
  },
  {
    icon: Eye,
    title: "OAuth ready",
    detail: "Google and GitHub buttons styled with provider icons. Divider pattern. Drop in your provider SDK to connect.",
  },
  {
    icon: Smartphone,
    title: "Mobile-first",
    detail: "Responsive from 320px up. Split layout on desktop, stacked on mobile. 48px input and button targets.",
  },
  {
    icon: Zap,
    title: "Trust signals",
    detail: "Testimonial, stats, feature badges, terms/privacy links, encryption callouts on confirmation.",
  },
  {
    icon: Code2,
    title: "Next.js + shadcn/ui",
    detail: "App Router, Tailwind v4, shadcn components. No runtime dependencies beyond React.",
  },
]

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Feature ticker - immediately below header */}
      <FeatureTicker />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/50">
        <div className="mx-auto max-w-6xl px-6 pt-10 pb-6 md:pt-14 md:pb-8">
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div className="space-y-3 max-w-2xl">
              <p className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
                Auth UI Kit
              </p>
              <h1 className="text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-foreground text-balance leading-[1.1]">
                Production auth screens, ready to ship.
              </h1>
              <p className="text-base text-muted-foreground max-w-lg text-pretty leading-relaxed">
                Sign up, login, forgot password, and confirmation flows. 
                Accessible, validated, responsive. Built with Next.js, shadcn/ui, and Tailwind.
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-col gap-3">
              <Button asChild size="lg" className="h-12 px-8">
                <Link href="/auth/signup">
                  Try signup
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="lg" className="h-12 px-8 bg-transparent">
                <Link href="/auth/login">
                  Try login
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Flows index */}
      <section className="border-b border-border/50">
        <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
          <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-6">
            4 Flows Included
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {flows.map((flow) => (
              <Link
                key={flow.title}
                href={flow.href}
                className="group rounded-lg border border-border bg-card p-5 hover:bg-secondary/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-1.5">
                    <h3 className="text-base font-semibold text-foreground group-hover:text-primary transition-colors">
                      {flow.title}
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed text-pretty">
                      {flow.description}
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1 group-hover:translate-x-1 transition-transform" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* What's built in */}
      <section className="border-b border-border/50">
        <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
          <div className="space-y-2 mb-8">
            <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              {"What's built in"}
            </h2>
            <p className="text-sm text-muted-foreground max-w-lg">
              Not a wireframe. Not a template with TODO comments. Every state is handled.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => {
              const Icon = feature.icon
              return (
                <div key={feature.title} className="space-y-3">
                  <div className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold text-foreground">{feature.title}</h3>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.detail}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50">
        <div className="mx-auto max-w-6xl px-6 py-12 md:py-16">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16">
            {/* Tech Stack */}
            <div className="space-y-4">
              <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Tech Stack</h3>
              <div className="flex flex-wrap gap-2">
                {["Next.js 16", "React 19", "Tailwind v4", "shadcn/ui", "Geist", "Lucide Icons", "TypeScript"].map((tech) => (
                  <span
                    key={tech}
                    className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-foreground"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </div>

            {/* Brand Assets */}
            <div className="space-y-4">
              <h3 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Brand Assets</h3>
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/thumbnail"
                  className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                >
                  Thumbnail
                </Link>
                <Link
                  href="/thumbnails"
                  className="inline-flex items-center rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                >
                  All Variants
                </Link>
              </div>
              <Button asChild variant="outline" size="sm" className="bg-transparent">
                <Link href="/thumbnails">
                  View all brand assets
                  <ArrowRight className="ml-1.5 h-3 w-3" />
                </Link>
              </Button>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="mt-10 pt-6 border-t border-border/50 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
            <span>Auth Template</span>
            <div className="flex gap-6">
              <Link href="/terms" className="hover:text-foreground transition-colors">Terms</Link>
              <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  )
}
