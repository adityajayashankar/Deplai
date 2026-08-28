"use client"

import { Check, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface PasswordMatchProps {
  password: string
  confirmPassword: string
  className?: string
}

export function PasswordMatch({ password, confirmPassword, className }: PasswordMatchProps) {
  if (!confirmPassword) return null

  const matches = password === confirmPassword

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm animate-in fade-in slide-in-from-top-1",
        className
      )}
      role="status"
      aria-live="polite"
    >
      {matches ? (
        <>
          <Check className="h-4 w-4 text-emerald-500" />
          <span className="text-emerald-500">Passwords match</span>
        </>
      ) : (
        <>
          <X className="h-4 w-4 text-destructive" />
          <span className="text-destructive">Passwords do not match</span>
        </>
      )}
    </div>
  )
}
