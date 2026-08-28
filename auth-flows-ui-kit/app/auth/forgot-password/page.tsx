"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function ForgotPasswordPage() {
  const [isLoading, setIsLoading] = React.useState(false)
  const [isSubmitted, setIsSubmitted] = React.useState(false)
  const [email, setEmail] = React.useState("")
  const [error, setError] = React.useState("")
  const inputRef = React.useRef<HTMLInputElement>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError("")

    if (!email.trim()) {
      setError("Email is required")
      inputRef.current?.focus()
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address")
      inputRef.current?.focus()
      return
    }

    setIsLoading(true)

    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1000))

    setIsSubmitted(true)
    setIsLoading(false)
  }

  if (isSubmitted) {
    return (
      <div className="space-y-6">
        <div className="flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <Mail className="h-8 w-8 text-primary" />
          </div>
        </div>

        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">Check your email</h1>
          <p className="text-muted-foreground">
            We sent a password reset link to
          </p>
          <p className="font-medium">{email}</p>
        </div>

        <div className="space-y-4">
          <Button
            asChild
            variant="outline"
            className="w-full h-12 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] bg-transparent"
          >
            <a href={`mailto:${email}`}>Open email app</a>
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Didn&apos;t receive the email?{" "}
            <button
              type="button"
              onClick={() => setIsSubmitted(false)}
              className="text-foreground underline underline-offset-4 hover:text-primary transition-colors"
            >
              Click to resend
            </button>
          </p>
        </div>

        <Link
          href="/auth/login"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Forgot password?</h1>
        <p className="text-muted-foreground">
          No worries, we&apos;ll send you reset instructions.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error && (
          <div
            role="alert"
            className="p-3 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20 animate-in fade-in slide-in-from-top-1"
          >
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            ref={inputRef}
            id="email"
            name="email"
            type="email"
            placeholder="john@example.com"
            className="h-12 bg-input border-border transition-all duration-200 focus:scale-[1.01]"
            disabled={isLoading}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "email-error" : undefined}
          />
          {error && (
            <p id="email-error" className="sr-only">{error}</p>
          )}
        </div>

        <Button
          type="submit"
          className="w-full h-12 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
          disabled={isLoading}
        >
          {isLoading ? "Sending..." : "Reset password"}
        </Button>
      </form>

      <Link
        href="/auth/login"
        className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to sign in
      </Link>
    </div>
  )
}
