"use client"

import Link from "next/link"
import { CheckCircle2, ArrowRight, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Confetti } from "@/components/auth/confetti"

export default function ThankYouPage() {
  return (
    <>
      <Confetti />
      <div className="flex flex-col items-center text-center space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        {/* Success icon with animated ring */}
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping" />
          <div className="relative w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center ring-2 ring-emerald-500/30">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
          </div>
        </div>
        
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            Welcome aboard!
          </h1>
          <p className="text-muted-foreground max-w-sm leading-relaxed">
            Your account has been created successfully. You're now ready to explore all the features of our platform.
          </p>
        </div>

        {/* Email confirmation notice */}
        <div className="flex items-center gap-3 p-4 rounded-lg bg-card border border-border max-w-sm w-full">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
            <Mail className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-foreground">Check your inbox</p>
            <p className="text-xs text-muted-foreground">We've sent a confirmation email</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs pt-2">
          <Button asChild className="flex-1 h-12 gap-2 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]">
            <Link href="/">
              Get started
              <ArrowRight className="w-4 h-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" className="flex-1 h-12 bg-transparent transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]">
            <Link href="/auth/login">
              Sign in
            </Link>
          </Button>
        </div>

        {/* Trust signals */}
        <div className="flex items-center gap-6 pt-4 text-muted-foreground">
          <div className="flex items-center gap-1.5 text-xs">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>256-bit encryption</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span>SOC 2 compliant</span>
          </div>
        </div>
      </div>
    </>
  )
}
