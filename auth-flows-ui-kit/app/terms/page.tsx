import Link from "next/link"
import { ArrowLeft } from "lucide-react"

export const metadata = {
  title: "Terms of Service",
  description: "Terms and conditions for using our service",
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:px-8">
        <Link
          href="/auth/signup"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign up
        </Link>

        <h1 className="text-4xl font-semibold tracking-tight mb-8">Terms of Service</h1>

        <div className="prose prose-invert prose-sm max-w-none space-y-6 text-muted-foreground">
          <p className="text-foreground/80">
            Last updated: January 31, 2026
          </p>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>
              By accessing and using this service, you accept and agree to be bound by the terms 
              and provision of this agreement. If you do not agree to abide by the above, please 
              do not use this service.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">2. Use License</h2>
            <p>
              Permission is granted to temporarily access the materials on our service for personal, 
              non-commercial transitory viewing only. This is the grant of a license, not a transfer 
              of title.
            </p>
            <p>Under this license you may not:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Modify or copy the materials</li>
              <li>Use the materials for any commercial purpose</li>
              <li>Attempt to decompile or reverse engineer any software</li>
              <li>Remove any copyright or other proprietary notations</li>
              <li>Transfer the materials to another person</li>
            </ul>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">3. Account Responsibilities</h2>
            <p>
              You are responsible for maintaining the confidentiality of your account and password. 
              You agree to accept responsibility for all activities that occur under your account.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">4. Privacy</h2>
            <p>
              Your use of our service is also governed by our{" "}
              <Link href="/privacy" className="text-foreground underline underline-offset-4 hover:text-primary">
                Privacy Policy
              </Link>
              . Please review our Privacy Policy, which also governs the site and informs users of 
              our data collection practices.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">5. Disclaimer</h2>
            <p>
              The materials on our service are provided on an &apos;as is&apos; basis. We make no 
              warranties, expressed or implied, and hereby disclaim and negate all other warranties 
              including, without limitation, implied warranties or conditions of merchantability, 
              fitness for a particular purpose, or non-infringement of intellectual property.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">6. Limitations</h2>
            <p>
              In no event shall we or our suppliers be liable for any damages arising out of the use 
              or inability to use the materials on our service, even if we have been notified of the 
              possibility of such damage.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">7. Modifications</h2>
            <p>
              We may revise these terms of service at any time without notice. By using this service 
              you are agreeing to be bound by the then current version of these terms of service.
            </p>
          </section>

          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-foreground">8. Contact</h2>
            <p>
              If you have any questions about these Terms, please contact us at{" "}
              <a href="mailto:legal@example.com" className="text-foreground underline underline-offset-4 hover:text-primary">
                legal@example.com
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
